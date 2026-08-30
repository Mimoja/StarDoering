import { constants, createWriteStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UpdateAsset, UpdateMethod, UpdateState } from '../shared/types'
import { isNewerVersion } from '../shared/version'
import * as appimage from './appimage'
import { describeHttpError, fmtBytes } from './github'
import { relaunchInto } from './relaunch'
import { logScope } from './activity'
import { ensureDir, errorMessage, readJson, rmrf, writeJson } from './util/fs'

const execFileAsync = promisify(execFile)
const log = logScope('app')

const API = 'https://api.github.com'
const HEADERS = { 'User-Agent': 'StarDoring', Accept: 'application/vnd.github+json' }
// The start-up check gets three seconds: offline or slow, the app opens without it. Later checks only keep the row honest.
const START_CHECK_TIMEOUT_MS = 3_000
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60_000
// One answer is kept for an hour: the unauthenticated GitHub quota is 60 calls per hour per network.
const CHECK_TTL_MS = 60 * 60_000
// A version that was installed once but still is not what runs is not installed again for a day – no update loops.
const RETRY_AFTER_MS = 24 * 60 * 60_000
// Where the app can replace itself. A deb needs root, so it is only announced.
const SELF_INSTALL: UpdateMethod[] = ['appimage', 'unpacked', 'nsis', 'portable', 'mac']

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

export interface UpdaterOptions {
  // "owner/repo" whose releases carry the builds.
  repo: string
  currentVersion: string
  isPackaged: boolean
  execPath: string
  tempDir: string
  // Remembers which version the last automatic update installed.
  attemptFile: string
  emit: (s: UpdateState) => void
}

// /Applications/StarDöring.app/Contents/MacOS/StarDöring → the .app folder, null for anything else.
function macBundle(execPath: string): string | null {
  const bundle = path.resolve(execPath, '..', '..', '..')
  return bundle.endsWith('.app') && path.basename(path.dirname(execPath)) === 'MacOS' ? bundle : null
}

// How this copy can be replaced – decided by where the executable lives.
export function detectMethod(isPackaged: boolean, execPath: string): UpdateMethod {
  if (!isPackaged) return 'none'
  switch (process.platform) {
    case 'linux':
      if (appimage.runningAppImage()) return 'appimage'
      if (appimage.runningAppDir()) return 'unpacked'
      return 'deb'
    case 'win32':
      if (process.env['PORTABLE_EXECUTABLE_FILE']) return 'portable'
      return existsSync(path.join(path.dirname(execPath), 'Uninstall StarDöring.exe')) ? 'nsis' : 'none'
    case 'darwin':
      return macBundle(execPath) ? 'mac' : 'none'
    default:
      return 'none'
  }
}

// electron-builder's arch tag differs per target: x86_64 in AppImage names, amd64 in deb names, x64 elsewhere.
function archTag(method: UpdateMethod): string {
  if (process.arch === 'arm64') return 'arm64'
  if (method === 'appimage' || method === 'unpacked') return 'x86_64'
  if (method === 'deb') return 'amd64'
  return process.arch
}

// What electron-builder.yml names the build for each method (artifactName: StarDoering-<version>-<arch>…).
const SUFFIX: Record<UpdateMethod, string | null> = { appimage: '.AppImage', unpacked: '.AppImage', deb: '.deb', nsis: '-setup.exe', portable: '-portable.exe', mac: '.zip', none: null }

// The release file for this computer, or null.
export function pickAsset(assets: ReleaseAsset[], method: UpdateMethod, version: string, tag = archTag(method)): UpdateAsset | null {
  const hit = SUFFIX[method] && assets.find((a) => a.name === `StarDoering-${version}-${tag}${SUFFIX[method]}`)
  return hit ? { name: hit.name, url: hit.browser_download_url, size: hit.size ?? null } : null
}

const BUSY: UpdateState['phase'][] = ['downloading', 'installing', 'restarting']

export class UpdateService {
  private readonly method: UpdateMethod
  private state: UpdateState
  private inFlight: Promise<UpdateState> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: UpdaterOptions) {
    this.method = detectMethod(opts.isPackaged, opts.execPath)
    this.state = {
      phase: 'idle',
      currentVersion: opts.currentVersion,
      latestVersion: null,
      releaseUrl: `https://github.com/${opts.repo}/releases/latest`,
      asset: null,
      method: this.method,
      gate: true,
      received: 0,
      total: null,
      message: '',
      checkedAt: null
    }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  // Let the app view render – called once the start-up update is over (or was never going to happen).
  releaseView(): void {
    if (this.state.gate) this.set({ gate: false })
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch }
    this.opts.emit({ ...this.state })
    return { ...this.state }
  }

  // At start: sweep what the last update renamed aside, check briefly, install a newer release. 'restarting' = on the way out.
  async runAtStart(): Promise<'continue' | 'restarting'> {
    await this.sweep()
    // A dev run checks too, so the logic can be watched – it never installs (method 'none').
    log.info(`Checking github.com/${this.opts.repo} for a newer release`, { detail: `this is ${this.opts.currentVersion}${this.opts.isPackaged ? ` (${this.method} install)` : ' (not a packaged build – nothing is installed)'}, ${START_CHECK_TIMEOUT_MS / 1000} s limit` })
    this.set({ message: 'Checking for updates…' })
    const s = await this.check({ timeoutMs: START_CHECK_TIMEOUT_MS })
    if (s.phase !== 'available' || !s.asset || !s.latestVersion) return 'continue'
    if (!SELF_INSTALL.includes(this.method)) {
      log.info(`StarDöring ${s.latestVersion} has to be installed by hand on this computer (${this.method})`)
      return 'continue'
    }
    const attempt = await readJson<{ version?: string; at?: number }>(this.opts.attemptFile, {})
    if (attempt.version === s.latestVersion && Date.now() - (attempt.at ?? 0) < RETRY_AFTER_MS) {
      log.warn(`StarDöring ${s.latestVersion} was installed already, but this is still ${this.opts.currentVersion} – not trying again today`)
      this.set({ message: `It was installed, but this is still ${this.opts.currentVersion} – get it from the release page.` })
      return 'continue'
    }
    const r = await this.install(s.asset, s.latestVersion)
    return r.phase === 'restarting' ? 'restarting' : 'continue'
  }

  // Later checks only refresh the Dashboard row; nothing installs while the app runs.
  startPolling(): void {
    if (!this.opts.isPackaged || this.timer) return
    this.timer = setInterval(() => void this.check(), AUTO_CHECK_EVERY_MS)
  }

  private async sweep(): Promise<void> {
    try {
      if (this.method === 'appimage' || this.method === 'unpacked') await appimage.sweepLeftovers()
      const own = this.method === 'unpacked' ? appimage.runningAppDir() : this.method === 'mac' ? macBundle(this.opts.execPath) : null
      if (own) await appimage.sweepDoomed(own)
    } catch (e) {
      log.debug(`Could not clean up after the last update: ${errorMessage(e)}`)
    }
  }

  // Ask GitHub for the latest release, at most once an hour.
  async check(o: { timeoutMs?: number } = {}): Promise<UpdateState> {
    if (this.inFlight) return this.inFlight
    if (BUSY.includes(this.state.phase)) return this.getState()
    if (this.state.checkedAt != null && Date.now() - this.state.checkedAt < CHECK_TTL_MS) return this.getState()
    this.inFlight = this.doCheck(o.timeoutMs ?? 20_000).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doCheck(timeoutMs: number): Promise<UpdateState> {
    try {
      const res = await fetch(`${API}/repos/${this.opts.repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 404) {
        log.info('No release has been published yet')
        return this.set({ phase: 'current', checkedAt: Date.now(), message: 'No release has been published yet.' })
      }
      if (!res.ok) throw describeHttpError(this.opts.repo, res)
      const json = (await res.json()) as { tag_name?: string; html_url?: string; assets?: ReleaseAsset[] }
      const latest = String(json.tag_name ?? '')
        .trim()
        .replace(/^v/i, '')
      if (!latest) throw new Error('The latest release has no version tag.')
      const releaseUrl = json.html_url ?? this.state.releaseUrl
      const asset = pickAsset(json.assets ?? [], this.method, latest)
      const checkedAt = Date.now()
      if (!isNewerVersion(latest, this.opts.currentVersion)) {
        log.info(`StarDöring ${this.opts.currentVersion} is up to date (latest release: ${latest})`)
        await fs.rm(this.opts.attemptFile, { force: true }).catch(() => undefined)
        return this.set({ phase: 'current', latestVersion: latest, releaseUrl, asset, checkedAt, message: `StarDöring ${this.opts.currentVersion} is up to date.` })
      }
      log.info(`StarDöring ${latest} is available (this is ${this.opts.currentVersion})`, { detail: asset ? `${asset.name}${asset.size ? ` (${fmtBytes(asset.size)})` : ''}` : `the release has no ${this.method} build for this computer` })
      return this.set({ phase: 'available', latestVersion: latest, releaseUrl, asset, checkedAt, received: 0, total: null, message: this.manualReason(asset) })
    } catch (e) {
      // Offline, rate-limited, slow: the state keeps what it knew; only the start-up view gets told why.
      const why = e instanceof Error && e.name === 'TimeoutError' ? `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s` : errorMessage(e)
      log.info(`Update check skipped: ${why}`)
      return this.state.gate ? this.set({ message: `No update check – ${why}` }) : this.getState()
    }
  }

  // Why an available release is not installed on its own – empty when it will be.
  private manualReason(asset: UpdateAsset | null): string {
    if (this.method === 'deb') return 'Download the deb from the release page and install it with your package manager.'
    if (this.method === 'none') return 'Get it from the release page.'
    if (!asset) return 'The release has no build for this computer.'
    return ''
  }

  private async install(asset: UpdateAsset, latest: string): Promise<UpdateState> {
    log.info(`Updating StarDöring ${this.opts.currentVersion} → ${latest} (${this.method})`, { detail: asset.url })
    let file: string | null = null
    try {
      await this.preflight()
      file = await this.download(asset)
      // Noted before anything is replaced: a restart that does not come up as `latest` must not start over.
      await writeJson(this.opts.attemptFile, { version: latest, at: Date.now() })
      this.set({ phase: 'installing', message: `Installing StarDöring ${latest}…` })
      return await this.apply(file, latest)
    } catch (e) {
      log.fail(`Update to ${latest} failed`, e)
      if (file) await fs.rm(file, { force: true }).catch(() => undefined)
      return this.set({ phase: 'error', message: errorMessage(e) })
    }
  }

  // Fail before the download when the place that has to change is not writable.
  private async preflight(): Promise<void> {
    const writable = async (p: string, hint: string): Promise<void> => {
      try {
        await fs.access(p, constants.W_OK)
      } catch {
        throw new Error(`${p} is not writable – ${hint}`)
      }
    }
    switch (this.method) {
      case 'appimage':
        return writable(path.dirname(appimage.runningAppImage() ?? ''), 'move the AppImage somewhere you can write to, or get the new one from the release page.')
      case 'unpacked':
        return writable(path.dirname(appimage.runningAppDir() ?? ''), 'get the new AppImage from the release page and install it from there.')
      case 'portable':
        return writable(process.env['PORTABLE_EXECUTABLE_DIR'] ?? '', 'move StarDöring somewhere you can write to, or get the new one from the release page.')
      case 'mac': {
        const bundle = macBundle(this.opts.execPath) ?? ''
        await writable(path.dirname(bundle), 'get the dmg from the release page and replace StarDöring.app by hand.')
        return writable(bundle, 'get the dmg from the release page and replace StarDöring.app by hand.')
      }
      default:
        return
    }
  }

  // Next to the AppImage / portable exe (same filesystem, so the final rename is atomic), otherwise the temp folder.
  private downloadDir(): string {
    switch (this.method) {
      case 'appimage':
        return path.dirname(appimage.runningAppImage() ?? this.opts.tempDir)
      case 'portable':
        return process.env['PORTABLE_EXECUTABLE_DIR'] ?? this.opts.tempDir
      default:
        return path.join(this.opts.tempDir, 'update')
    }
  }

  private async download(asset: UpdateAsset): Promise<string> {
    const dir = this.downloadDir()
    await ensureDir(dir)
    const file = path.join(dir, asset.name)
    const part = path.join(dir, `.${asset.name}.part`)
    this.set({ phase: 'downloading', received: 0, total: asset.size, message: `Downloading ${asset.name}…` })
    const res = await fetch(asset.url, { headers: { 'User-Agent': 'StarDoring' }, signal: AbortSignal.timeout(30 * 60_000) })
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || asset.size
    let received = 0
    let last = 0
    const reader = Readable.fromWeb(res.body as never)
    reader.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (Date.now() - last > 250) {
        last = Date.now()
        this.set({ received, total, message: `Downloading ${asset.name}… ${fmtBytes(received)}${total ? ` of ${fmtBytes(total)}` : ''}` })
      }
    })
    try {
      await pipeline(reader, createWriteStream(part))
      if (asset.size != null && received !== asset.size) throw new Error(`The download is incomplete (${fmtBytes(received)} of ${fmtBytes(asset.size)}).`)
      await fs.rename(part, file)
    } catch (e) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      throw e
    }
    this.set({ received, total, message: `Downloaded ${asset.name}.` })
    log.debug(`Downloaded ${asset.name} (${fmtBytes(received)}) to ${dir}`)
    return file
  }

  private async apply(file: string, latest: string): Promise<UpdateState> {
    const restarting = (exec: string, opts?: Parameters<typeof relaunchInto>[1]): UpdateState => {
      log.info(`Restarting into ${exec}`)
      relaunchInto(exec, opts)
      return this.set({ phase: 'restarting', message: `Restarting into StarDöring ${latest}…` })
    }
    switch (this.method) {
      case 'appimage': {
        // The name stays: the desktop entry, the Steam shortcut and the download page keep working. The runtime
        // keeps the old inode mounted, so replacing the directory entry underneath it is safe.
        const current = appimage.runningAppImage()!
        await fs.chmod(file, 0o755)
        await fs.rename(file, current)
        log.info(`Replaced ${current} with StarDöring ${latest}`)
        return restarting(current)
      }
      case 'unpacked': {
        await fs.chmod(file, 0o755)
        const exec = await appimage.replaceInstall(file, appimage.runningAppDir()!)
        await fs.rm(file, { force: true }).catch(() => undefined)
        return restarting(exec)
      }
      case 'nsis':
        // The installer replaces the install folder silently and starts the app again itself.
        relaunchInto(file, { args: ['/S', '--updated', '--force-run'] })
        return this.set({ phase: 'restarting', message: `Running the StarDöring ${latest} installer – the app starts again when it is done.` })
      case 'portable':
        return restarting(file, { remove: process.env['PORTABLE_EXECUTABLE_FILE'] })
      case 'mac':
        return restarting(await this.replaceBundle(file))
      default:
        throw new Error('This copy of StarDöring cannot update itself.')
    }
  }

  // Unpack the zip beside the bundle (ditto keeps symlinks and permissions, and adds no quarantine flag to files we
  // downloaded ourselves), then swap the bundles. The old one is only renamed aside and swept on the next start.
  private async replaceBundle(zip: string): Promise<string> {
    const bundle = macBundle(this.opts.execPath)!
    const scratch = path.join(path.dirname(bundle), `.${path.basename(bundle, '.app')}-update`)
    await rmrf(scratch)
    await ensureDir(scratch)
    try {
      await execFileAsync('ditto', ['-x', '-k', zip, scratch], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 })
      const name = (await fs.readdir(scratch)).find((n) => n.endsWith('.app'))
      if (!name) throw new Error(`${path.basename(zip)} contains no .app bundle.`)
      await appimage.swapIn(path.join(scratch, name), bundle)
    } finally {
      await rmrf(scratch).catch(() => undefined)
    }
    await fs.rm(zip, { force: true }).catch(() => undefined)
    log.info(`Replaced ${bundle}`)
    return bundle
  }
}

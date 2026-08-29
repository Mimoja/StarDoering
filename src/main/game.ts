import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { extractZip } from './util/zip'
import type { AppSettings, GameCandidate, GameInfo, GameSource, LaunchMode, SmapiInfo, SmapiInstallResult } from '../shared/types'
import { currentPlatform, defaultSavesDir, findGameCandidates, resolveGameDir, smapiLogPath, stardewDataDir, steamRoots, STEAM_APP_ID } from './paths'
import { isNewerVersion } from '../shared/version'
import { fetchLatestSmapiVersion } from './modlist/resolve'
import { logScope } from './activity'
import { ensureDir, errorMessage, exists, isDir, isFile, readText, rmrf } from './util/fs'

const execFileAsync = promisify(execFile)

const log = logScope('game')

// Read "<assembly>/<version>" out of a .NET deps.json – the cleanest version source for both the game and SMAPI.
export async function readDepsVersion(depsJsonPath: string, assemblyName: string): Promise<string | null> {
  const text = await readText(depsJsonPath)
  if (!text) return null
  const re = new RegExp(`"${assemblyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([0-9][^"]*)"`)
  const m = re.exec(text)
  return m ? m[1] : null
}

export async function readGameVersion(gameDir: string): Promise<string | null> {
  return (await readDepsVersion(path.join(gameDir, 'Stardew Valley.deps.json'), 'Stardew Valley')) ?? (await readPeProductVersion(path.join(gameDir, 'Stardew Valley.dll')))
}

// ProductVersion/FileVersion out of the Win32 VERSIONINFO resource .NET embeds in every assembly (also on
// macOS/Linux builds). The strings are UTF-16LE: "ProductVersion\0" + padding + "4.5.2\0".
export async function readPeProductVersion(dllPath: string): Promise<string | null> {
  let buf: Buffer
  try {
    buf = await fs.readFile(dllPath)
  } catch {
    return null
  }
  for (const key of ['ProductVersion', 'FileVersion']) {
    const needle = Buffer.from(key + '\0', 'utf16le')
    let from = 0
    while (from < buf.length) {
      const at = buf.indexOf(needle, from)
      if (at < 0) break
      let pos = at + needle.length
      while (pos < buf.length - 1 && buf[pos] === 0 && buf[pos + 1] === 0) pos += 2 // alignment padding
      let end = pos
      while (end < buf.length - 1 && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2
      const value = buf.subarray(pos, end).toString('utf16le').trim()
      const m = /^(\d+(?:\.\d+){1,3})/.exec(value)
      if (m) return m[1]
      from = at + needle.length
    }
  }
  return null
}

export async function readSmapiInfo(gameDir: string): Promise<SmapiInfo> {
  const dll = path.join(gameDir, 'StardewModdingAPI.dll')
  const installed = await isFile(dll)
  const version = installed ? (await readDepsVersion(path.join(gameDir, 'StardewModdingAPI.deps.json'), 'StardewModdingAPI')) ?? (await readPeProductVersion(dll)) : null

  let launcherPath: string | null = null
  if (installed) {
    const candidates =
      process.platform === 'win32'
        ? ['StardewModdingAPI.exe']
        : ['StardewModdingAPI', 'StardewValley'] // unix installer drops a launcher script + replaces the Steam launcher
    for (const c of candidates) {
      const p = path.join(gameDir, c)
      if (await isFile(p)) {
        launcherPath = p
        break
      }
    }
  }

  return { installed, version, launcherPath }
}

// Parse the header of SMAPI-latest.txt, e.g. "SMAPI 4.1.10 with Stardew Valley 1.6.15 (build 24356) on macOS 15.5".
export async function parseSmapiLog(logPath: string): Promise<GameInfo['lastRun']> {
  const text = await readText(logPath)
  if (!text) return null
  const head = text.slice(0, 4000)
  const m = /SMAPI (\S+) with Stardew Valley (\S+)(?: \(?build [^)\n]*?\)?)? on (.+)$/m.exec(head)
  const started = /Log started at (.+?) UTC/.exec(head)
  return {
    smapiVersion: m?.[1] ?? null,
    gameVersion: m?.[2] ?? null,
    os: m?.[3]?.trim() ?? null,
    at: started?.[1] ?? null
  }
}

export interface GameServiceDeps {
  settings: () => Promise<AppSettings>
  openExternal: (url: string) => Promise<void>
  openPath: (p: string) => Promise<string>
  tempDir: string
}

export class GameService extends EventEmitter {
  private info: GameInfo | null = null
  private child: ChildProcess | null = null
  /** Set while a game started through Steam is running (we have no child process to watch, so we poll). */
  private steamRunning = false
  private steamPoll: NodeJS.Timeout | null = null
  // What the last detection told the log – re-detections only log when something actually changed.
  private loggedDetection: string | null = null

  constructor(private readonly deps: GameServiceDeps) {
    super()
  }

  async getInfo(refresh = false): Promise<GameInfo> {
    if (!this.info || refresh) this.info = await this.detect()
    this.info.running = this.child != null || this.steamRunning
    return this.info
  }

  async detect(): Promise<GameInfo> {
    const settings = await this.deps.settings()
    const platform = currentPlatform()
    const dataDir = stardewDataDir()
    const savesDir = settings.savesDirOverride ?? defaultSavesDir()
    const logPath = smapiLogPath(dataDir)

    const rawCandidates = await findGameCandidates()
    const candidates: GameCandidate[] = []
    for (const c of rawCandidates) {
      candidates.push({ path: c.path, source: c.source, version: await readGameVersion(c.path), hasSmapi: await isFile(path.join(c.path, 'StardewModdingAPI.dll')) })
    }

    let gameDir: string | null = null
    let source: GameSource = 'unknown'
    if (settings.gameDirOverride) {
      const resolved = await resolveGameDir(settings.gameDirOverride)
      if (resolved) {
        gameDir = resolved
        source = candidates.find((c) => c.path === resolved)?.source ?? 'manual'
      }
    }
    if (!gameDir && candidates.length > 0) {
      // Prefer an install that already has SMAPI, then Steam.
      const best = [...candidates].sort((a, b) => Number(b.hasSmapi) - Number(a.hasSmapi) || Number(a.source !== 'steam') - Number(b.source !== 'steam'))[0]
      gameDir = best.path
      source = best.source
    }

    const smapi: SmapiInfo = gameDir ? await readSmapiInfo(gameDir) : { installed: false, version: null, launcherPath: null }
    const lastRun = await parseSmapiLog(logPath)
    const detected = `${gameDir ?? 'none'}|${source}|${smapi.version ?? ''}`
    if (detected === this.loggedDetection) {
      log.debug(gameDir ? `Stardew Valley is still in ${gameDir}` : 'Stardew Valley is still missing')
    } else {
      this.loggedDetection = detected
      if (gameDir) log.info(`Found Stardew Valley in ${gameDir} (${source})`, { detail: `SMAPI: ${smapi.installed ? smapi.version ?? 'installed' : 'not installed'}` })
      else log.warn('Stardew Valley was not found – set the game folder on the dashboard')
    }

    return {
      platform,
      found: gameDir != null,
      gameDir,
      gameVersion: gameDir ? (await readGameVersion(gameDir)) ?? lastRun?.gameVersion ?? null : null,
      source,
      candidates,
      smapi: { ...smapi, version: smapi.version ?? (smapi.installed ? lastRun?.smapiVersion ?? null : null) },
      dataDir,
      savesDir,
      savesDirExists: await isDir(savesDir),
      modsDir: gameDir ? path.join(gameDir, 'Mods') : null,
      smapiLogPath: (await exists(logPath)) ? logPath : null,
      lastRun,
      running: this.child != null || this.steamRunning
    }
  }

  requireGameDir(): string {
    const dir = this.info?.gameDir
    if (!dir) throw new Error('Stardew Valley was not found. Set the game folder in Settings.')
    return dir
  }

  requireModsDir(): string {
    return path.join(this.requireGameDir(), 'Mods')
  }

  async launch(mode: LaunchMode): Promise<{ ok: boolean; error?: string; warning?: string }> {
    const info = await this.getInfo()
    if (this.child || this.steamRunning) return { ok: false, error: 'The game is already running.' }
    // A Steam copy is always started through Steam – that is the only way achievements, the overlay and cloud
    // saves work. SMAPI still loads: on macOS/Linux its installer swapped Steam's launcher for its own, on
    // Windows Steam needs the launch option pointing at StardewModdingAPI.exe (checked below).
    if (mode === 'steam' || (mode === 'smapi' && info.source === 'steam')) {
      let warning: string | undefined
      if (mode === 'smapi' && process.platform === 'win32' && info.gameDir && !(await steamLaunchOptionsUseSmapi())) {
        warning = `Steam will start the game without SMAPI until its launch options are set. In Steam: Stardew Valley → Properties → Launch Options: "${path.join(info.gameDir, 'StardewModdingAPI.exe')}" %command%`
      }
      log.info('Handing the launch over to Steam')
      await this.deps.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
      this.watchSteamLaunch()
      return { ok: true, warning }
    }
    if (!info.gameDir) return { ok: false, error: 'Game folder not found.' }

    let exe: string | null = null
    if (mode === 'smapi') {
      exe = info.smapi.launcherPath
      if (!exe) return { ok: false, error: 'SMAPI is not installed. Install it from the dashboard first.' }
    } else {
      const names =
        process.platform === 'win32'
          ? ['Stardew Valley.exe']
          : ['StardewValley-original', 'Stardew Valley', 'StardewValley'] // SMAPI renames the original unix launcher
      for (const n of names) {
        const p = path.join(info.gameDir, n)
        if (await isFile(p)) {
          exe = p
          break
        }
      }
      if (!exe) return { ok: false, error: 'Could not find the game executable.' }
    }

    try {
      log.info(`Starting Stardew Valley (${mode})`, { detail: exe })
      const child = spawn(exe, [], { cwd: info.gameDir, env: gameEnv(), detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      this.child = child
      child.once('exit', (code) => {
        this.child = null
        log.info(`The game exited${code != null ? ` (code ${code})` : ''}`)
        this.emit('exit', { code })
      })
      child.once('error', (err) => {
        this.child = null
        log.fail('The game could not be started', err)
        this.emit('exit', { code: null, error: errorMessage(err) })
      })
      return { ok: true }
    } catch (e) {
      log.fail(`Starting Stardew Valley (${mode}) failed`, e)
      return { ok: false, error: errorMessage(e) }
    }
  }

  /** After handing a launch to Steam: poll for the game process to show "running" and to notice when it exits. */
  private watchSteamLaunch(): void {
    if (this.steamPoll) clearInterval(this.steamPoll)
    const startedAt = Date.now()
    let seen = false
    this.steamPoll = setInterval(async () => {
      const running = await isGameProcessRunning()
      if (running && !seen) {
        seen = true
        this.steamRunning = true
        this.emit('started')
      } else if (!running && seen) {
        this.steamRunning = false
        if (this.steamPoll) clearInterval(this.steamPoll)
        this.steamPoll = null
        this.emit('exit', { code: null })
      } else if (!seen && Date.now() - startedAt > 3 * 60_000) {
        if (this.steamPoll) clearInterval(this.steamPoll) // Steam never started it (cancelled, update, …)
        this.steamPoll = null
      }
    }, 4000)
  }

  async openDir(which: 'game' | 'mods' | 'saves' | 'data' | 'logs'): Promise<void> {
    const info = await this.getInfo()
    const map: Record<typeof which, string | null> = {
      game: info.gameDir,
      mods: info.modsDir,
      saves: info.savesDir,
      data: info.dataDir,
      logs: path.join(info.dataDir, 'ErrorLogs')
    }
    const target = map[which]
    if (!target) throw new Error('Folder not available')
    await ensureDir(target)
    await this.deps.openPath(target)
  }

  // Latest SMAPI release on GitHub (cached an hour); null when offline or rate-limited.
  async latestSmapi(): Promise<string | null> {
    return fetchLatestSmapiVersion()
  }

  // Download the latest SMAPI installer and run it non-interactively against the game folder.
  async installSmapi(): Promise<SmapiInstallResult> {
    const info = await this.getInfo(true)
    if (!info.gameDir) return { ok: false, message: 'Game folder not found.' }
    if (this.child) return { ok: false, message: 'Close the game before installing SMAPI.' }

    const workDir = path.join(this.deps.tempDir, 'smapi-installer')
    await rmrf(workDir)
    await ensureDir(workDir)
    try {
      const res0 = await fetch('https://api.github.com/repos/Pathoschild/SMAPI/releases/latest', { headers: { 'User-Agent': 'StarDoring', Accept: 'application/vnd.github+json' } })
      if (!res0.ok) {
        // Unauthenticated GitHub calls are capped per IP (60/hour), and the app makes others as well.
        const reset = Number(res0.headers.get('x-ratelimit-reset'))
        const limited = res0.status === 403 && res0.headers.get('x-ratelimit-remaining') === '0'
        const until = limited && reset ? ` It resets at ${new Date(reset * 1000).toLocaleTimeString()}.` : ''
        const message = limited
          ? `GitHub's API rate limit is used up for this network.${until} Try again later, or install SMAPI by hand from smapi.io.`
          : `GitHub answered HTTP ${res0.status} for the SMAPI release – try again later, or install SMAPI by hand from smapi.io.`
        log.error(message)
        return { ok: false, message }
      }
      const release = (await res0.json()) as { tag_name: string; assets?: { name: string; browser_download_url: string }[] }
      // Nothing to do when the installed build is already the released one – re-running the installer
      // for an identical version only costs a download and a game-folder rewrite.
      const latest = String(release.tag_name ?? '').replace(/^v/i, '')
      if (info.smapi.installed && info.smapi.version && latest && !isNewerVersion(latest, info.smapi.version)) {
        log.info(`SMAPI ${info.smapi.version} is already up to date (latest release ${latest})`)
        return { ok: true, message: `SMAPI ${info.smapi.version} is already up to date.`, version: info.smapi.version, alreadyCurrent: true }
      }
      if (!Array.isArray(release.assets)) {
        const message = 'GitHub returned no asset list for the latest SMAPI release – try again later, or install SMAPI by hand from smapi.io.'
        log.error(message, { detail: JSON.stringify(release).slice(0, 500) })
        return { ok: false, message }
      }
      const asset = release.assets.find((a) => /^SMAPI-[0-9][^ ]*-installer\.zip$/i.test(a.name))
      if (!asset) {
        log.error(`No installer asset found in SMAPI release ${release.tag_name}`)
        return { ok: false, message: `No installer asset found in SMAPI release ${release.tag_name}` }
      }
      log.info(`Downloading SMAPI ${release.tag_name} (${asset.name})`)

      const zipPath = path.join(workDir, asset.name)
      const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'StarDoring' } })
      if (!res.ok || !res.body) return { ok: false, message: `Download failed: HTTP ${res.status}` }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath))

      const extractDir = path.join(workDir, 'unpacked')
      await extractZip(zipPath, extractDir)

      const platformFolder = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macOS' : 'linux'
      const installerDir = await findDir(extractDir, path.join('internal', platformFolder))
      if (!installerDir) return { ok: false, message: 'Installer layout not recognised (internal/<platform> folder missing).' }
      const exe = path.join(installerDir, process.platform === 'win32' ? 'SMAPI.Installer.exe' : 'SMAPI.Installer')
      if (!(await isFile(exe))) return { ok: false, message: `Installer executable missing: ${exe}` }
      if (process.platform !== 'win32') await fs.chmod(exe, 0o755)

      log.info(`Running the SMAPI installer against ${info.gameDir}`)
      const output = await runAndCapture(exe, ['--install', '--game-path', info.gameDir, '--no-prompt'], installerDir)
      const after = await this.getInfo(true)
      if (!after.smapi.installed) {
        log.error('The SMAPI installer finished but SMAPI was not detected', { detail: output.slice(-4000) })
        return { ok: false, message: `Installer finished but SMAPI was not detected.\n${output.slice(-1500)}` }
      }
      log.info(`SMAPI ${after.smapi.version ?? release.tag_name} installed`, { detail: output.slice(-4000) })
      return { ok: true, message: `SMAPI ${after.smapi.version ?? release.tag_name} installed.`, version: after.smapi.version ?? undefined }
    } catch (e) {
      log.fail('Installing SMAPI failed', e)
      // A failed run is not a run that changed nothing: the installer copies files as it goes, so a
      // crash partway (a full disk, a killed process) leaves a half-installed SMAPI behind. Without
      // re-detecting here the dashboard keeps showing what was true before the attempt.
      await this.getInfo(true).catch(() => undefined)
      return { ok: false, message: errorMessage(e) }
    } finally {
      await rmrf(workDir).catch(() => undefined)
    }
  }
}

async function findDir(root: string, suffix: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const direct = path.join(root, suffix)
  if (await isDir(direct)) return direct
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findDir(path.join(root, e.name), suffix)
    if (found) return found
  }
  return null
}

/**
 * The environment Stardew Valley should start in.
 *
 * When Steam launches StarDöring as a non-Steam game it stamps that shortcut's identity on us –
 * SteamAppId=<shortcut id>, SteamGameId, SteamOverlayGameId. A child inherits all of it, so the game
 * would initialise Steam against a shortcut that is not a Steam app and report that it cannot reach
 * the online services (no invites, no co-op). Hand it Stardew's own app id instead, and drop the
 * per-launch variables that describe how *we* were started.
 */
function gameEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['SteamGameId', 'SteamOverlayGameId', 'SteamClientLaunch', 'SteamEnv', 'STEAM_COMPAT_MEDIA_PATH', 'STEAM_COMPAT_TRANSCODED_MEDIA_PATH', 'LD_PRELOAD']) {
    delete env[key]
  }
  // Lets the game attach to a running Steam client for multiplayer even though Steam did not start it.
  env['SteamAppId'] = STEAM_APP_ID
  env['SteamGameId'] = STEAM_APP_ID
  return env
}

/** Is a Stardew Valley / SMAPI process running? (used after a launch through Steam, which gives us no child process) */
async function isGameProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/NH'], { windowsHide: true })
      return /Stardew Valley\.exe|StardewModdingAPI\.exe/i.test(stdout)
    }
    const { stdout } = await execFileAsync('pgrep', ['-fl', 'StardewModdingAPI|Stardew Valley|StardewValley'])
    return stdout.split('\n').some((l) => l.trim() && !/pgrep/.test(l))
  } catch {
    return false
  }
}

/** Windows only: does Steam's launch option for the game run SMAPI? (userdata/<id>/config/localconfig.vdf) */
async function steamLaunchOptionsUseSmapi(): Promise<boolean> {
  for (const root of await steamRoots()) {
    const userdata = path.join(root, 'userdata')
    let ids: string[] = []
    try {
      ids = await fs.readdir(userdata)
    } catch {
      continue
    }
    for (const id of ids) {
      const text = await readText(path.join(userdata, id, 'config', 'localconfig.vdf'))
      if (!text) continue
      const at = text.indexOf(`"${STEAM_APP_ID}"`)
      if (at < 0) continue
      const block = text.slice(at, at + 4000)
      const m = /"LaunchOptions"\s+"([^"]*)"/.exec(block)
      if (m && /StardewModdingAPI/i.test(m[1])) return true
    }
  }
  return false
}

function runAndCapture(exe: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`Installer exited with code ${code}\n${out.slice(-1500)}`))))
  })
}

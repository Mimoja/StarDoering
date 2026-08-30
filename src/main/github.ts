import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { GithubInstallProgress, GithubInstallRequest, GithubRelease, ModInstallResult } from '../shared/types'
import { installModZips } from './mods'
import { ensureDir, rmrf } from './util/fs'
import { logScope } from './activity'
import { normalizeGithubRepo } from './modlist/format'

const log = logScope('modlist')

const API = 'https://api.github.com'
const CACHE_TTL_MS = 10 * 60 * 1000

// Repo → last answer. Clicking "Check GitHub" twice in a row must not cost two of the 60 calls per hour.
const cache = new Map<string, { at: number; release: GithubRelease }>()

const HEADERS = { 'User-Agent': 'StarDoring', Accept: 'application/vnd.github+json' }

// GitHub's unauthenticated quota is 60/hour per IP – say so plainly instead of surfacing a bare HTTP code.
export function describeHttpError(repo: string, res: Response): Error {
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const until = reset ? ` It resets at ${new Date(reset * 1000).toLocaleTimeString()}.` : ''
    return new Error(`GitHub's API rate limit is used up for this network.${until}`)
  }
  if (res.status === 404) return new Error(`GitHub has no repository "${repo}" (or it is private).`)
  return new Error(`GitHub answered HTTP ${res.status} for "${repo}".`)
}

function stripV(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

// The newest version a repository publishes: its latest release, else its newest tag. Deliberately manual –
// one API call against a 60/hour unauthenticated budget, so it is never run for a whole list at once.
export async function fetchLatestGithubRelease(repoInput: string): Promise<GithubRelease> {
  const repo = normalizeGithubRepo(repoInput)
  if (!repo) throw new Error(`"${repoInput}" is not an "owner/repo" GitHub reference.`)

  const hit = cache.get(repo)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.release

  log.debug(`Asking GitHub for the latest release of ${repo}`)
  const res = await fetch(`${API}/repos/${repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) })
  let release: GithubRelease | null = null
  if (res.ok) {
    const json = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string }
    if (typeof json.tag_name === 'string' && json.tag_name.trim()) {
      release = { repo, version: stripV(json.tag_name), url: json.html_url ?? `https://github.com/${repo}/releases`, publishedAt: json.published_at ?? null, source: 'release' }
    }
  } else if (res.status !== 404) {
    throw describeHttpError(repo, res)
  }

  // No published release (404, or a release without a tag): fall back to the newest tag.
  if (!release) {
    const tagRes = await fetch(`${API}/repos/${repo}/tags?per_page=1`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!tagRes.ok) throw describeHttpError(repo, tagRes)
    const tags = (await tagRes.json()) as { name?: string }[]
    const name = Array.isArray(tags) ? tags[0]?.name : null
    if (!name) throw new Error(`"${repo}" has no releases or tags yet.`)
    release = { repo, version: stripV(name), url: `https://github.com/${repo}/tags`, publishedAt: null, source: 'tag' }
  }

  log.info(`GitHub: ${repo} is at ${release.version} (${release.source})`)
  cache.set(repo, { at: Date.now(), release })
  return release
}

export function fmtBytes(n: number): string {
  return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

/** Pick the release zip for a mod: the one matching the hint, else the only zip, else the first zip. */
export function pickZipAsset(assets: ReleaseAsset[], hints: string[]): ReleaseAsset | null {
  const zips = assets.filter((a) => /\.zip$/i.test(a.name))
  if (zips.length === 0) return null
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const hint of hints.map(norm).filter(Boolean)) {
    const hit = zips.find((a) => norm(a.name).includes(hint))
    if (hit) return hit
  }
  return zips.length === 1 ? zips[0] : zips[0]
}

/**
 * Download the latest release zip of a GitHub-hosted mod and install it into Mods/, reporting progress
 * (resolving → downloading with byte counts → installing → done/error). Never throws: the final event says.
 */
export async function installFromGithub(req: GithubInstallRequest, opts: { modsDir: string; tempDir: string; emit: (p: GithubInstallProgress) => void; afterInstall?: (r: ModInstallResult) => Promise<void> }): Promise<GithubInstallProgress> {
  const repo = normalizeGithubRepo(req.repo)
  const base: GithubInstallProgress = { id: req.id, name: req.name, repo: repo ?? req.repo, phase: 'resolving', received: 0, total: null, message: '', version: null, installed: [] }
  const emit = (patch: Partial<GithubInstallProgress>): GithubInstallProgress => {
    Object.assign(base, patch)
    opts.emit({ ...base })
    return { ...base }
  }
  if (!repo) return emit({ phase: 'error', message: `"${req.repo}" is not an "owner/repo" GitHub reference.` })
  const workDir = path.join(opts.tempDir, `github-${req.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}`)
  try {
    emit({ phase: 'resolving', message: `Looking up the latest release of ${repo}…` })
    log.info(`Installing ${req.name} from github.com/${repo}`)
    const res = await fetch(`${API}/repos/${repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw describeHttpError(repo, res)
    const json = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] }
    const version = json.tag_name ? stripV(json.tag_name) : null
    const asset = pickZipAsset(json.assets ?? [], [req.asset ?? '', req.name, req.id.split('.').pop() ?? ''])
    if (!asset) throw new Error(`The latest release of ${repo} (${version ?? 'unknown version'}) has no zip file – get it from the release page by hand.`)

    emit({ phase: 'downloading', version, total: asset.size ?? null, message: `Downloading ${asset.name}…` })
    await ensureDir(workDir)
    const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'StarDoring' }, signal: AbortSignal.timeout(10 * 60_000) })
    if (!dl.ok || !dl.body) throw new Error(`Download failed: HTTP ${dl.status}`)
    const total = Number(dl.headers.get('content-length')) || asset.size || null
    const zipPath = path.join(workDir, asset.name)
    let received = 0
    let lastEmit = 0
    const reader = Readable.fromWeb(dl.body as never)
    reader.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (Date.now() - lastEmit > 200) {
        lastEmit = Date.now()
        emit({ received, total, message: `Downloading ${asset.name}… ${fmtBytes(received)}${total ? ` of ${fmtBytes(total)}` : ''}` })
      }
    })
    await pipeline(reader, createWriteStream(zipPath))
    emit({ received, total, phase: 'installing', message: `Installing ${req.name}…` })
    const result = await installModZips(opts.modsDir, [zipPath], workDir)
    if (result.installed.length === 0) throw new Error(result.errors.join('\n') || 'The zip contained no SMAPI mod (no manifest.json).')
    await opts.afterInstall?.(result)
    log.info(`Installed ${result.installed.join(', ')} from github.com/${repo}`)
    return emit({ phase: 'done', installed: result.installed, message: `Installed ${result.installed.join(', ')}${result.errors.length ? `\n${result.errors.join('\n')}` : ''}` })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.warn(`GitHub install of ${req.name} failed: ${message}`)
    return emit({ phase: 'error', message })
  } finally {
    await rmrf(workDir).catch(() => undefined)
  }
}

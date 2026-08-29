import type { ModInfo, Modlist, ModlistEntry, ModlistEntryState, ModlistEntryStatus, ModlistExtraMod, ModlistSmapiStatus } from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { logScope } from '../activity'
import { errorMessage, readJson, writeJson } from '../util/fs'
import { indexByUniqueId, normalizeGithubRepo, parseUpdateKey, toPositiveInt } from './format'
import { httpGet } from './http'

const log = logScope('modlist')

// Pathoschild's mod dataset: maps every known SMAPI mod ID to its mod pages ("Nexus:1063", "GitHub:owner/repo", …).
export const DATASET_INDEX_URL = 'https://raw.githubusercontent.com/Pathoschild/StardewModDataset/main/dataset/indexes/pages%20by%20mod%20ID.json'
const DATASET_TTL_MS = 24 * 60 * 60 * 1000

export interface ModPages {
  nexus: number | null
  curseforge: number | null
  moddrop: number | null
  github: string | null
  // Original update keys.
  keys: string[]
}
export type DatasetIndex = Map<string, ModPages>

interface DatasetCache {
  fetchedAt: number
  data: Record<string, string[]>
}

export function pagesFromKeys(keys: string[]): ModPages {
  const out: ModPages = { nexus: null, curseforge: null, moddrop: null, github: null, keys: [] }
  for (const key of keys) {
    if (typeof key !== 'string') continue
    const p = parseUpdateKey(key)
    if (!p) continue
    out.keys.push(key)
    // Several pages can carry the same mod (bundles, translations, forks); the original upload has the lowest ID.
    const lower = (cur: number | null, next: number | null): number | null => (next == null ? cur : cur == null ? next : Math.min(cur, next))
    if (p.site === 'nexus') out.nexus = lower(out.nexus, toPositiveInt(p.id))
    else if (p.site === 'curseforge') out.curseforge = lower(out.curseforge, toPositiveInt(p.id))
    else if (p.site === 'moddrop') out.moddrop = lower(out.moddrop, toPositiveInt(p.id))
    else if (p.site === 'github' && out.github == null) out.github = normalizeGithubRepo(p.id)
  }
  return out
}

export function buildDatasetIndex(data: Record<string, string[]>): DatasetIndex {
  const index: DatasetIndex = new Map()
  for (const [id, keys] of Object.entries(data)) {
    if (!Array.isArray(keys)) continue
    const k = id.toLowerCase()
    const existing = index.get(k)
    index.set(k, pagesFromKeys(existing ? [...existing.keys, ...keys] : keys))
  }
  return index
}

// Load the dataset index, refreshing it from GitHub at most once a day. Never throws – degrades to a stale or empty index.
export async function loadDatasetIndex(cacheFile: string, opts: { force?: boolean; now?: number } = {}): Promise<{ index: DatasetIndex; warning: string | null; fetchedAt: number | null }> {
  const now = opts.now ?? Date.now()
  const cached = await readJson<DatasetCache | null>(cacheFile, null)
  const cacheOk = cached != null && typeof cached.fetchedAt === 'number' && cached.data != null && typeof cached.data === 'object'
  if (cacheOk && !opts.force && now - cached.fetchedAt < DATASET_TTL_MS) {
    log.debug(`Using the cached mod dataset from ${new Date(cached.fetchedAt).toLocaleString()}`)
    return { index: buildDatasetIndex(cached.data), warning: null, fetchedAt: cached.fetchedAt }
  }
  log.info('Fetching the mod page dataset from GitHub')
  try {
    const res = await httpGet(DATASET_INDEX_URL, {}, 90_000)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, string[]>
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('unexpected format')
    await writeJson(cacheFile, { fetchedAt: now, data } satisfies DatasetCache)
    log.info(`Mod page dataset updated (${Object.keys(data).length} mods)`)
    return { index: buildDatasetIndex(data), warning: null, fetchedAt: now }
  } catch (e) {
    const msg = errorMessage(e)
    if (cacheOk) {
      log.warn(`Using the cached mod dataset (${msg})`)
      return { index: buildDatasetIndex(cached.data), warning: `Using the cached mod dataset (${msg})`, fetchedAt: cached.fetchedAt }
    }
    log.warn(`Mod dataset unavailable (${msg}) – mod pages can only be resolved from the modlist itself`)
    return { index: new Map(), warning: `Mod dataset unavailable (${msg}) – mod pages can only be resolved from the modlist itself`, fetchedAt: null }
  }
}

let smapiLatestCache: { at: number; version: string | null } | null = null

// Latest SMAPI release tag from GitHub, cached for an hour; null when offline.
export async function fetchLatestSmapiVersion(): Promise<string | null> {
  if (smapiLatestCache && Date.now() - smapiLatestCache.at < 60 * 60 * 1000) return smapiLatestCache.version
  try {
    const res = await httpGet('https://api.github.com/repos/Pathoschild/SMAPI/releases/latest', { Accept: 'application/vnd.github+json' })
    if (!res.ok) return null
    const json = (await res.json()) as { tag_name?: string }
    const version = typeof json.tag_name === 'string' ? json.tag_name.replace(/^v/i, '') : null
    smapiLatestCache = { at: Date.now(), version }
    return version
  } catch {
    return null
  }
}

export function nexusPageUrl(id: number): string {
  return `https://www.nexusmods.com/stardewvalley/mods/${id}`
}

export function minimumVersion(entry: ModlistEntry): string | null {
  return entry.version && entry.version.toLowerCase() !== 'latest' ? entry.version : null
}

// The part of the mod catalog this module needs: the dataset's own view of each mod's newest release.
export interface CatalogLookup {
  get(id: string): { version: string | null; nexus: number | null; github: string | null; pageUrl: string | null } | null
}

export interface ResolveContext {
  smapiVersion: string | null
  datasetCacheFile: string
  // Optional so scripts and tests can resolve without one – latest versions are then simply unknown.
  catalog?: CatalogLookup
}

export interface ResolveResult {
  entries: ModlistEntryStatus[]
  extra: ModlistExtraMod[]
  smapi: ModlistSmapiStatus
  warnings: string[]
}

export function entryState(entry: ModlistEntry, mod: ModInfo | undefined, latestVersion: string | null): ModlistEntryState {
  if (!mod) return 'missing'
  if (!mod.enabled) return 'disabled'
  const min = minimumVersion(entry)
  if (min) return compareVersions(mod.version, min) < 0 ? 'outdated' : 'installed'
  if (latestVersion && mod.version && compareVersions(latestVersion, mod.version) > 0) return 'outdated'
  return 'installed'
}

async function smapiStatus(required: string, ctx: ResolveContext): Promise<ModlistSmapiStatus> {
  const installed = ctx.smapiVersion
  const wantsLatest = required.toLowerCase() === 'latest'
  const latest = wantsLatest ? await fetchLatestSmapiVersion() : null
  if (!installed) return { required, installed, latest, ok: false, message: 'SMAPI is not installed.' }
  if (wantsLatest) {
    if (latest && compareVersions(latest, installed) > 0) return { required, installed, latest, ok: false, message: `SMAPI ${installed} is installed, ${latest} is available.` }
    return { required, installed, latest, ok: true, message: latest ? `SMAPI ${installed} is up to date.` : `SMAPI ${installed} is installed (could not check for a newer release).` }
  }
  if (compareVersions(installed, required) < 0) return { required, installed, latest, ok: false, message: `The modlist needs SMAPI ${required} or newer, but ${installed} is installed.` }
  return { required, installed, latest, ok: true, message: `SMAPI ${installed} satisfies the required ${required}.` }
}

// Compare a modlist with the installed mods and enrich each entry with pages + latest versions. Never throws for network trouble.
export async function resolveModlist(modlist: Modlist, installed: ModInfo[], ctx: ResolveContext): Promise<ResolveResult> {
  const warnings: string[] = []
  const byId = indexByUniqueId(installed)

  const dataset = await loadDatasetIndex(ctx.datasetCacheFile)
  if (dataset.warning) warnings.push(dataset.warning)

  const entries: ModlistEntryStatus[] = modlist.mods.map((entry) => {
    const k = entry.id.toLowerCase()
    const mod = byId.get(k)
    const pages = dataset.index.get(k)
    // The locally cloned dataset (refreshed on start) is the version source – smapi.io's update API is unmaintained.
    const cat = ctx.catalog?.get(entry.id) ?? null
    const installedKeys = pagesFromKeys(mod?.updateKeys ?? [])
    const nexusId = entry.nexus ?? pages?.nexus ?? cat?.nexus ?? installedKeys.nexus ?? null
    const githubRepo = entry.github ?? pages?.github ?? cat?.github ?? installedKeys.github ?? null
    const latestVersion = cat?.version ?? null
    const pageUrl = entry.url ?? (nexusId ? nexusPageUrl(nexusId) : null) ?? (githubRepo ? `https://github.com/${githubRepo}/releases` : null) ?? cat?.pageUrl ?? null
    const desiredEnabled = entry.enabled !== false
    return {
      entry,
      state: entryState(entry, mod, latestVersion),
      installedVersion: mod?.version ?? null,
      installedFolder: mod?.folder ?? null,
      desiredEnabled,
      enabledMismatch: mod != null && mod.enabled !== desiredEnabled,
      latestVersion,
      pageUrl,
      githubRepo,
      errors: []
    }
  })

  const listed = new Set(modlist.mods.map((e) => e.id.toLowerCase()))
  // SMAPI's own bundled mods are never part of a server config, so they are not "extra" (downloaded) mods either.
  const extra: ModlistExtraMod[] = installed
    .filter((m) => !m.isBundled && !(m.uniqueId && listed.has(m.uniqueId.toLowerCase())))
    .map((m) => ({ folder: m.folder, uniqueId: m.uniqueId, name: m.name, version: m.version, enabled: m.enabled }))

  const smapi = await smapiStatus(modlist.smapi, ctx)
  return { entries, extra, smapi, warnings }
}

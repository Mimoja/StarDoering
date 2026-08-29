import JSON5 from 'json5'
import type { ModInfo, ModlistEntry, ModlistParseResult } from '../../shared/types'
import { parseVersion } from '../../shared/version'
import { stripBom } from '../util/fs'

export const MODLIST_FILE_NAME = 'modlist.json5'

const ENTRY_KEYS = new Set(['id', 'name', 'nexus', 'github', 'githubAsset', 'url', 'version', 'optional', 'enabled', 'note'])
const ROOT_KEYS = new Set(['name', 'smapi', 'mods'])

// Accepts "owner/repo", a github.com URL or a ".git" clone URL and returns "owner/repo".
export function normalizeGithubRepo(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s)
  if (m) s = `${m[1]}/${m[2]}`
  s = s.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null
}

export function toPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

function isVersionOrLatest(v: unknown): v is string {
  return typeof v === 'string' && (v.trim().toLowerCase() === 'latest' || parseVersion(v.trim()) != null)
}

// "Nexus:1063", "GitHub:owner/repo@subkey" … → { site: 'nexus', id: '1063' }
export function parseUpdateKey(key: string): { site: string; id: string } | null {
  const m = /^\s*([A-Za-z]+)\s*:\s*([^@]+?)\s*(?:@.*)?$/.exec(key)
  return m ? { site: m[1].toLowerCase(), id: m[2].trim() } : null
}

export interface UpdateKeySources {
  nexus?: number
  github?: string
  curseforge?: number
  moddrop?: number
}

// Derive page IDs from SMAPI manifest update keys.
export function sourcesFromUpdateKeys(keys: string[]): UpdateKeySources {
  const out: UpdateKeySources = {}
  for (const key of keys) {
    const p = parseUpdateKey(key)
    if (!p) continue
    if (p.site === 'nexus' && out.nexus == null) out.nexus = toPositiveInt(p.id) ?? undefined
    else if (p.site === 'github' && out.github == null) out.github = normalizeGithubRepo(p.id) ?? undefined
    else if (p.site === 'curseforge' && out.curseforge == null) out.curseforge = toPositiveInt(p.id) ?? undefined
    else if (p.site === 'moddrop' && out.moddrop == null) out.moddrop = toPositiveInt(p.id) ?? undefined
  }
  return out
}

function parseEntry(raw: unknown, index: number, errors: string[], warnings: string[]): ModlistEntry | null {
  const where = `mods[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where}: must be an object like { id: "Author.ModName" }`)
    return null
  }
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) {
    errors.push(`${where}: "id" (the SMAPI UniqueID from manifest.json) is required`)
    return null
  }
  const label = `${where} (${id})`
  const problems: string[] = []
  const entry: ModlistEntry = { id }

  if (o.name != null) {
    if (typeof o.name === 'string') {
      if (o.name.trim()) entry.name = o.name.trim()
    } else problems.push('"name" must be a string')
  }
  if (o.nexus != null) {
    const n = toPositiveInt(o.nexus)
    if (n) entry.nexus = n
    else problems.push('"nexus" must be a positive Nexus mod ID like 1063')
  }
  if (o.github != null) {
    const r = normalizeGithubRepo(o.github)
    if (r) entry.github = r
    else problems.push('"github" must be "owner/repo"')
  }
  if (o.githubAsset != null) {
    if (typeof o.githubAsset === 'string' && o.githubAsset.trim()) entry.githubAsset = o.githubAsset.trim()
    else problems.push('"githubAsset" must be a non-empty string')
  }
  if (o.url != null) {
    if (typeof o.url === 'string' && /^https?:\/\/\S+$/i.test(o.url.trim())) entry.url = o.url.trim()
    else problems.push('"url" must be an http(s) URL')
  }
  if (o.version != null) {
    if (isVersionOrLatest(o.version)) {
      const v = o.version.trim()
      if (v.toLowerCase() !== 'latest') entry.version = v
    } else problems.push('"version" must be "latest" or a minimum version like "1.2.3"')
  }
  if (o.optional != null) {
    if (typeof o.optional === 'boolean') {
      if (o.optional) entry.optional = true
    } else problems.push('"optional" must be true or false')
  }
  if (o.enabled != null) {
    if (typeof o.enabled === 'boolean') {
      if (!o.enabled) entry.enabled = false
    } else problems.push('"enabled" must be true or false')
  }
  if (o.note != null) {
    if (typeof o.note === 'string') {
      if (o.note.trim()) entry.note = o.note.trim()
    } else problems.push('"note" must be a string')
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) warnings.push(`${label}: the ID contains unusual characters – SMAPI IDs use letters, digits, ".", "_" and "-"`)
  for (const k of Object.keys(o)) if (!ENTRY_KEYS.has(k)) warnings.push(`${label}: unknown key "${k}" ignored`)
  if (entry.githubAsset && !entry.github) warnings.push(`${label}: "githubAsset" has no effect without "github"`)

  if (problems.length) {
    errors.push(...problems.map((p) => `${label}: ${p}`))
    return null
  }
  return entry
}

// Parse + validate a modlist.json5 document. Comments and trailing commas are allowed. Invalid entries are skipped and reported.
export function parseModlist(text: string): ModlistParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON5.parse(stripBom(text))
  } catch (e) {
    return { modlist: null, errors: [`Not valid JSON5: ${e instanceof Error ? e.message : String(e)}`], warnings }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { modlist: null, errors: ['The modlist must be an object like { name: "…", smapi: "latest", mods: [ … ] }'], warnings }
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.mods)) return { modlist: null, errors: ['"mods" must be an array of entries'], warnings }

  let name = 'Modlist'
  if (o.name != null) {
    if (typeof o.name === 'string' && o.name.trim()) name = o.name.trim()
    else warnings.push('"name" should be a non-empty string')
  }
  let smapi = 'latest'
  if (o.smapi != null) {
    if (isVersionOrLatest(o.smapi)) smapi = o.smapi.trim().toLowerCase() === 'latest' ? 'latest' : o.smapi.trim()
    else errors.push('"smapi" must be "latest" or a version like "4.1.10"')
  }
  for (const k of Object.keys(o)) if (!ROOT_KEYS.has(k)) warnings.push(`unknown top-level key "${k}" ignored`)

  const mods: ModlistEntry[] = []
  const seen = new Map<string, number>()
  o.mods.forEach((rawEntry: unknown, i: number) => {
    const entry = parseEntry(rawEntry, i, errors, warnings)
    if (!entry) return
    const key = entry.id.toLowerCase()
    const dup = seen.get(key)
    if (dup != null) {
      errors.push(`mods[${i}] (${entry.id}): duplicate of mods[${dup}] – IDs are compared case-insensitively`)
      return
    }
    seen.set(key, i)
    mods.push(entry)
  })
  return { modlist: { name, smapi, mods }, errors, warnings }
}

export interface GenerateOptions {
  // Used only when the existing text has no `name`.
  name?: string
  // Used only when the existing text has no `smapi`.
  smapi?: string
  generatedAt?: Date
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

// Installed mods by lower-cased UniqueID, preferring an enabled copy when a mod exists twice.
export function indexByUniqueId(mods: ModInfo[]): Map<string, ModInfo> {
  const byId = new Map<string, ModInfo>()
  for (const m of mods) {
    if (!m.uniqueId) continue
    const k = m.uniqueId.toLowerCase()
    const prev = byId.get(k)
    if (!prev || (!prev.enabled && m.enabled)) byId.set(k, m)
  }
  return byId
}

function newEntry(m: ModInfo): Record<string, unknown> {
  const e: Record<string, unknown> = { id: m.uniqueId, name: m.name }
  const src = sourcesFromUpdateKeys(m.updateKeys)
  if (src.nexus) e.nexus = src.nexus
  if (src.github) e.github = src.github
  if (!m.enabled) e.enabled = false
  return e
}

// modlist.json5 text from the installed mods. With `existing`, a merge: entries keep order and extra fields, `enabled`
// follows the local state, page IDs come from UpdateKeys, unlisted mods are appended; comments are lost. Throws on invalid JSON5.
export function generateModlist(mods: ModInfo[], existing?: string | null, opts: GenerateOptions = {}): string {
  // SMAPI's own mods are never part of a server config.
  const installed = mods.filter((m) => m.uniqueId && !m.isBundled)
  const byId = indexByUniqueId(installed)

  let root: Record<string, unknown> = {}
  if (existing && existing.trim()) {
    const raw: unknown = JSON5.parse(stripBom(existing))
    if (!isPlainObject(raw)) throw new Error('The existing modlist must be an object like { name, smapi, mods: [ … ] }')
    root = raw
  }

  const out: Record<string, unknown> = {}
  if (!('name' in root)) out.name = opts.name ?? 'Our farm'
  if (!('smapi' in root)) out.smapi = opts.smapi ?? 'latest'
  for (const [k, v] of Object.entries(root)) if (k !== 'mods') out[k] = v

  const seen = new Set<string>()
  const merged: unknown[] = []
  for (const raw of Array.isArray(root.mods) ? (root.mods as unknown[]) : []) {
    if (!isPlainObject(raw)) {
      merged.push(raw)
      continue
    }
    const e: Record<string, unknown> = { ...raw }
    const id = typeof e.id === 'string' ? e.id.trim().toLowerCase() : ''
    const mod = id ? byId.get(id) : undefined
    if (id) seen.add(id)
    if (mod) {
      if (mod.enabled) {
        if ('enabled' in e) e.enabled = true
      } else e.enabled = false
      if (e.nexus == null && e.github == null && e.url == null) {
        const src = sourcesFromUpdateKeys(mod.updateKeys)
        if (src.nexus) e.nexus = src.nexus
        if (src.github) e.github = src.github
      }
      if (e.name == null && mod.name) e.name = mod.name
    }
    merged.push(e)
  }
  const additions = installed.filter((m) => !seen.has(m.uniqueId.toLowerCase()) && byId.get(m.uniqueId.toLowerCase()) === m).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  for (const m of additions) merged.push(newEntry(m))
  out.mods = merged
  return serializeModlist(out, { updated: Boolean(existing?.trim()), generatedAt: opts.generatedAt })
}

// modlist.json5 text with the explanatory header comment.
export function serializeModlist(root: Record<string, unknown>, opts: { updated?: boolean; generatedAt?: Date } = {}): string {
  const when = (opts.generatedAt ?? new Date()).toISOString().slice(0, 10)
  const header = [
    `// ${MODLIST_FILE_NAME} – ${opts.updated === false ? 'generated' : 'updated'} by StarDöring on ${when}`,
    '// JSON5: comments and trailing commas are fine. "id" is the SMAPI UniqueID and the only required field.',
    '// Optional per mod: name, nexus: <id>, github: "owner/repo", githubAsset: "<zip name part>", url, version ("latest" or a minimum),',
    '// optional: true (not needed on every device), enabled: false (installed but switched off), note.'
  ]
  return `${header.join('\n')}\n${JSON5.stringify(root, { space: 2, quote: '"' })}\n`
}

// Apply `mutate` to the `mods` array of modlist text (a fresh document when text is empty) and re-serialize.
// `mutate` may return a new array. Throws on invalid JSON5.
export function editModlist(text: string | null, mutate: (mods: Record<string, unknown>[]) => Record<string, unknown>[] | void, opts: { name?: string; smapi?: string; root?: (root: Record<string, unknown>) => void } = {}): string {
  let root: Record<string, unknown> = { name: opts.name ?? 'Our farm', smapi: opts.smapi ?? 'latest', mods: [] }
  if (text && text.trim()) {
    const raw: unknown = JSON5.parse(stripBom(text))
    if (!isPlainObject(raw)) throw new Error('The modlist must be an object like { name, smapi, mods: [ … ] }')
    root = { ...raw }
    if (!Array.isArray(root.mods)) root.mods = []
  }
  const mods = (root.mods as unknown[]).filter(isPlainObject) as Record<string, unknown>[]
  root.mods = mutate(mods) ?? mods
  opts.root?.(root)
  return serializeModlist(root, { updated: Boolean(text && text.trim()) })
}

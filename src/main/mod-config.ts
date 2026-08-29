import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModConfigDoc, ModConfigEdit, ModConfigField, ModConfigValue } from '../shared/types'
import { logScope } from './activity'
import { errorMessage, exists, parseLenientJson, readText, safeJoin, writeFileAtomic } from './util/fs'
import { parseManifest } from './mods'

const log = logScope('mods')

// Nothing good comes from turning a 5000-entry lookup table into 5000 form rows – the JSON editor covers those.
const MAX_FIELDS = 400
const MAX_DEPTH = 5

const CONTENT_PATCHER_ID = 'pathoschild.contentpatcher'

function isPlainObject(v: unknown): v is Record<string, ModConfigValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// "UseCustomSpeed" / "use_custom_speed" → "Use custom speed"; an all-caps word stays as it is.
function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return key
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// Content Patcher's ConfigSchema – the one mod config schema that is actually
// written down. Everything else is inferred from the values in config.json.

interface SchemaEntry {
  // The field name as the mod spells it – the lower-cased map key is for lookups only.
  name: string
  description: string | null
  choices: string[] | null
  // AllowMultiple: the value is a comma-separated list of the allowed values.
  multiple: boolean
  default: ModConfigValue | null
  hasDefault: boolean
}

function lower(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = v
  return out
}

function splitList(v: unknown): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Read `ConfigSchema` out of a Content Patcher pack's content.json – it gives the menu what a plain config.json
// cannot: a description, the allowed values and the author's default per field.
async function readContentPatcherSchema(dir: string, contentPackFor: string | undefined): Promise<Map<string, SchemaEntry> | null> {
  if ((contentPackFor ?? '').toLowerCase() !== CONTENT_PATCHER_ID) return null
  const text = await readText(path.join(dir, 'content.json'))
  if (text == null) return null
  let raw: unknown
  try {
    raw = parseLenientJson(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw)) return null
  const schemaRaw = lower(raw as Record<string, unknown>).configschema
  if (!isPlainObject(schemaRaw)) return null

  const out = new Map<string, SchemaEntry>()
  for (const [field, defRaw] of Object.entries(schemaRaw)) {
    // A bare `"Field": "Default"` shorthand is legal too.
    if (!isPlainObject(defRaw)) {
      out.set(field.toLowerCase(), { name: field, description: null, choices: null, multiple: false, default: defRaw as ModConfigValue, hasDefault: true })
      continue
    }
    const d = lower(defRaw as Record<string, unknown>)
    const choices = d.allowvalues != null ? splitList(d.allowvalues) : null
    out.set(field.toLowerCase(), {
      name: field,
      description: d.description != null ? String(d.description) : null,
      choices: choices && choices.length > 0 ? choices : null,
      multiple: d.allowmultiple === true || String(d.allowmultiple ?? '').toLowerCase() === 'true',
      default: d.default == null ? null : (d.default as ModConfigValue),
      hasDefault: d.default != null
    })
  }
  return out
}

// Fields

function fieldFor(pathParts: string[], value: ModConfigValue, schema: SchemaEntry | undefined): ModConfigField {
  const key = pathParts[pathParts.length - 1]
  const section = pathParts.length > 1 ? pathParts.slice(0, -1).join(' › ') : null
  const base = {
    path: pathParts,
    label: humanise(key),
    section,
    description: schema?.description ?? null,
    default: schema?.hasDefault ? (schema.default ?? null) : null,
    hasDefault: Boolean(schema?.hasDefault),
    integer: false,
    choices: null as string[] | null
  }

  if (schema?.choices) {
    return { ...base, type: schema.multiple ? 'choices' : 'choice', choices: schema.choices, value: value == null ? '' : String(value) }
  }
  if (typeof value === 'boolean') return { ...base, type: 'boolean', value }
  if (typeof value === 'number')
    return { ...base, type: 'number', integer: Number.isInteger(value) && (typeof base.default !== 'number' || Number.isInteger(base.default)), value }
  if (typeof value === 'string') return { ...base, type: 'string', value }
  return { ...base, type: 'json', value }
}

// Walk the config object depth-first, one form field per leaf; nested objects become sections.
function collectFields(value: ModConfigValue, schema: Map<string, SchemaEntry> | null, prefix: string[], out: ModConfigField[]): boolean {
  if (!isPlainObject(value)) return false
  let truncated = false
  for (const [key, child] of Object.entries(value)) {
    if (out.length >= MAX_FIELDS) return true
    const parts = [...prefix, key]
    // Only the top level has a schema: Content Patcher's ConfigSchema is flat.
    const entry = prefix.length === 0 ? schema?.get(key.toLowerCase()) : undefined
    if (isPlainObject(child) && !entry && parts.length < MAX_DEPTH && Object.keys(child).length > 0) {
      truncated = collectFields(child, schema, parts, out) || truncated
      continue
    }
    out.push(fieldFor(parts, child, entry))
  }
  return truncated
}

// Reading / writing

function configPath(modsDir: string, folder: string): string {
  return path.join(safeJoin(modsDir, folder), 'config.json')
}

// Everything the config menu of one mod needs: the fields, the raw text behind them, and whatever the mod says
// about its settings (Content Patcher packs describe theirs).
export async function readModConfigDoc(modsDir: string, folder: string): Promise<ModConfigDoc> {
  const dir = safeJoin(modsDir, folder)
  const file = path.join(dir, 'config.json')
  const manifestRaw = await readText(path.join(dir, 'manifest.json'))
  let modName = path.basename(folder).replace(/^\.+/, '')
  let uniqueId = ''
  let contentPackFor: string | undefined
  if (manifestRaw != null) {
    try {
      const m = parseManifest(parseLenientJson(manifestRaw))
      modName = m.name || modName
      uniqueId = m.uniqueId
      contentPackFor = m.contentPackFor?.uniqueId
    } catch {
      // an unreadable manifest costs the nice name, nothing else
    }
  }

  const schema = await readContentPatcherSchema(dir, contentPackFor)
  const text = await readText(file)
  const doc: ModConfigDoc = {
    folder,
    modName,
    uniqueId,
    path: file,
    exists: text != null,
    text,
    schemaSource: schema ? 'content-patcher' : 'none',
    fields: [],
    parseError: null,
    truncated: false,
    canCreate: text == null && schema != null && schema.size > 0
  }

  let parsed: ModConfigValue = {}
  if (text != null) {
    try {
      parsed = parseLenientJson<ModConfigValue>(text)
    } catch (e) {
      doc.parseError = errorMessage(e)
      return doc
    }
    if (!isPlainObject(parsed)) {
      doc.parseError = 'config.json is not a JSON object – only the JSON editor can change it.'
      return doc
    }
  }

  const fields: ModConfigField[] = []
  doc.truncated = collectFields(parsed, schema, [], fields)

  // Settings the mod documents but has never written out yet (a fresh pack, or a new option after an
  // update) – show them with their default so they can be set before the game has run once.
  if (schema) {
    const present = new Set(fields.filter((f) => f.path.length === 1).map((f) => f.path[0].toLowerCase()))
    for (const [key, entry] of schema) {
      if (present.has(key) || fields.length >= MAX_FIELDS) continue
      fields.push(fieldFor([entry.name], entry.default ?? '', entry))
    }
  }

  doc.fields = fields
  return doc
}

function setAt(root: Record<string, ModConfigValue>, parts: string[], value: ModConfigValue): void {
  let node: Record<string, ModConfigValue> = root
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (!isPlainObject(next)) {
      const fresh: Record<string, ModConfigValue> = {}
      node[part] = fresh
      node = fresh
    } else {
      node = next
    }
  }
  node[parts[parts.length - 1]] = value
}

function serialise(value: ModConfigValue): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// Apply the edited fields to config.json, leaving every other key (and the key order) as it was. SMAPI rewrites
// config.json on every launch anyway, so the file is normalised to 2-space JSON.
export async function saveModConfigValues(modsDir: string, folder: string, edits: ModConfigEdit[]): Promise<ModConfigDoc> {
  const file = configPath(modsDir, folder)
  const text = await readText(file)
  let root: ModConfigValue = {}
  if (text != null) {
    root = parseLenientJson<ModConfigValue>(text)
    if (!isPlainObject(root)) throw new Error('config.json is not a JSON object – edit it as JSON instead.')
  }
  const obj = root as Record<string, ModConfigValue>
  for (const edit of edits) {
    if (!Array.isArray(edit.path) || edit.path.length === 0) throw new Error('Invalid field path')
    setAt(obj, edit.path, edit.value)
  }
  await writeFileAtomic(file, serialise(obj))
  log.info(`Saved ${edits.length} setting${edits.length === 1 ? '' : 's'} in the config of "${folder}"`, {
    detail: edits.map((e) => `${e.path.join('.')} = ${JSON.stringify(e.value)}`).join('\n')
  })
  return readModConfigDoc(modsDir, folder)
}

// Replace config.json with hand-edited JSON (validated before it is written).
export async function saveModConfigText(modsDir: string, folder: string, content: string): Promise<ModConfigDoc> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    throw new Error(`Not valid JSON: ${errorMessage(e)}`)
  }
  await writeFileAtomic(configPath(modsDir, folder), serialise(parsed as ModConfigValue))
  log.info(`Saved the config.json of "${folder}" from the JSON editor`)
  return readModConfigDoc(modsDir, folder)
}

// Write the defaults a Content Patcher pack documents – for a pack whose config.json does not exist yet.
export async function createModConfig(modsDir: string, folder: string): Promise<ModConfigDoc> {
  const dir = safeJoin(modsDir, folder)
  const manifest = await readText(path.join(dir, 'manifest.json'))
  let contentPackFor: string | undefined
  if (manifest != null) {
    try {
      contentPackFor = parseManifest(parseLenientJson(manifest)).contentPackFor?.uniqueId
    } catch {
      // handled by the empty-schema check below
    }
  }
  const schema = await readContentPatcherSchema(dir, contentPackFor)
  if (!schema || schema.size === 0) throw new Error('This mod does not describe its settings – start the game once and it will write its own config.json.')
  const out: Record<string, ModConfigValue> = {}
  for (const entry of schema.values()) out[entry.name] = entry.default ?? ''
  await writeFileAtomic(path.join(dir, 'config.json'), serialise(out))
  log.info(`Created a config.json for "${folder}" from its Content Patcher defaults`)
  return readModConfigDoc(modsDir, folder)
}

// Back to the author's defaults: a pack that documents them gets them written back; for every other mod the only
// source of defaults is the mod itself, so config.json is removed and the mod writes a fresh one at the next launch.
export async function resetModConfig(modsDir: string, folder: string, trash?: (p: string) => Promise<void>): Promise<ModConfigDoc> {
  const dir = safeJoin(modsDir, folder)
  const file = path.join(dir, 'config.json')
  const manifest = await readText(path.join(dir, 'manifest.json'))
  let contentPackFor: string | undefined
  if (manifest != null) {
    try {
      contentPackFor = parseManifest(parseLenientJson(manifest)).contentPackFor?.uniqueId
    } catch {
      // falls through to the delete path
    }
  }
  const schema = await readContentPatcherSchema(dir, contentPackFor)
  if (schema && schema.size > 0) {
    const out: Record<string, ModConfigValue> = {}
    for (const entry of schema.values()) out[entry.name] = entry.default ?? ''
    await writeFileAtomic(file, serialise(out))
    log.info(`Reset the config of "${folder}" to the mod's defaults`)
    return readModConfigDoc(modsDir, folder)
  }
  if (await exists(file)) {
    if (trash) await trash(file)
    else await fs.rm(file)
    log.info(`Removed the config.json of "${folder}" – the mod writes a fresh one at the next launch`)
  }
  return readModConfigDoc(modsDir, folder)
}

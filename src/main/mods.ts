import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extractZip } from './util/zip'
import type { ModDependency, ModInfo, ModInstallResult, ModKind } from '../shared/types'
import { parseVersion } from '../shared/version'
import { logScope } from './activity'
import { copyDir, dirStats, ensureDir, errorMessage, exists, isDir, readJsonLenient, readText, rmrf, safeJoin, toPosix, writeFileAtomic } from './util/fs'

const log = logScope('mods')

const BUNDLED_MOD_IDS = new Set(['smapi.consolecommands', 'smapi.errorhandler', 'smapi.savebackup'])
const BUNDLED_MOD_FOLDERS = new Set(['consolecommands', 'errorhandler', 'savebackup'])

// A folder is "disabled" for SMAPI when its name (or any parent's inside Mods/) starts with a dot.
export function isDisabledFolder(relFolder: string): boolean {
  return relFolder.split('/').some((seg) => seg.startsWith('.'))
}

// Strip the leading dot(s) that mark a folder as disabled – the identity of a mod independent of its enabled state.
export function normalizeModFolder(relFolder: string): string {
  return relFolder
    .split('/')
    .map((seg) => seg.replace(/^\.+/, ''))
    .join('/')
}

type RawManifest = Record<string, unknown>

function lowerKeys(o: unknown): RawManifest {
  const out: RawManifest = {}
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) out[k.toLowerCase()] = v
  }
  return out
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v)
}

export interface ParsedManifest {
  name: string
  author: string
  version: string
  description: string
  uniqueId: string
  kind: ModKind
  entryDll?: string
  contentPackFor?: { uniqueId: string; minimumVersion?: string }
  minimumApiVersion?: string
  minimumGameVersion?: string
  dependencies: ModDependency[]
  updateKeys: string[]
  errors: string[]
}

export function parseManifest(raw: unknown): ParsedManifest {
  const m = lowerKeys(raw)
  const errors: string[] = []
  const versionParsed = parseVersion(m.version)
  if (!versionParsed) errors.push('Missing or invalid Version')
  const uniqueId = str(m.uniqueid).trim()
  if (!uniqueId) errors.push('Missing UniqueID')
  const entryDll = m.entrydll ? str(m.entrydll) : undefined
  const cpf = m.contentpackfor ? lowerKeys(m.contentpackfor) : null
  const contentPackFor = cpf && cpf.uniqueid ? { uniqueId: str(cpf.uniqueid), minimumVersion: cpf.minimumversion ? str(cpf.minimumversion) : undefined } : undefined
  const kind: ModKind = entryDll ? 'smapi' : contentPackFor ? 'content-pack' : 'unknown'
  if (kind === 'unknown') errors.push('Manifest has neither EntryDll nor ContentPackFor')

  const dependencies: ModDependency[] = []
  if (Array.isArray(m.dependencies)) {
    for (const d of m.dependencies) {
      const dd = lowerKeys(d)
      if (!dd.uniqueid) continue
      dependencies.push({ uniqueId: str(dd.uniqueid), minimumVersion: dd.minimumversion ? str(dd.minimumversion) : undefined, isRequired: dd.isrequired == null ? true : Boolean(dd.isrequired) })
    }
  }
  const updateKeys = Array.isArray(m.updatekeys) ? m.updatekeys.map((k) => str(k)).filter(Boolean) : []

  return {
    name: str(m.name, uniqueId || '(unnamed)'),
    author: str(m.author),
    version: versionParsed?.raw ?? str(m.version),
    description: str(m.description),
    uniqueId,
    kind,
    entryDll,
    contentPackFor,
    minimumApiVersion: m.minimumapiversion ? str(m.minimumapiversion) : undefined,
    minimumGameVersion: m.minimumgameversion ? str(m.minimumgameversion) : undefined,
    dependencies,
    updateKeys,
    errors
  }
}

async function findManifest(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'manifest.json')
  return hit ? path.join(dir, hit.name) : null
}

// Scan Mods/ the way SMAPI does: a folder with a manifest.json is a mod, any other folder is searched recursively.
// Dot-prefixed folders are disabled but still reported.
export async function scanMods(modsDir: string): Promise<ModInfo[]> {
  const mods: ModInfo[] = []
  if (!(await isDir(modsDir))) return mods

  async function visit(dir: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '__MACOSX' || entry.name === '.git') continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = path.join(dir, entry.name)
      const manifestPath = await findManifest(childAbs)
      if (manifestPath) {
        mods.push(await readMod(childAbs, childRel, manifestPath))
      } else {
        await visit(childAbs, childRel)
      }
    }
  }
  await visit(modsDir, '')

  // Resolve dependencies against the enabled set.
  const enabledIds = new Set(mods.filter((m) => m.enabled && m.uniqueId).map((m) => m.uniqueId.toLowerCase()))
  for (const mod of mods) {
    const missing: string[] = []
    for (const dep of mod.dependencies) {
      if (dep.isRequired && !enabledIds.has(dep.uniqueId.toLowerCase())) missing.push(dep.uniqueId)
    }
    if (mod.contentPackFor && !enabledIds.has(mod.contentPackFor.uniqueId.toLowerCase())) missing.push(mod.contentPackFor.uniqueId)
    mod.missingDependencies = missing
  }
  mods.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return mods
}

async function readMod(folderPath: string, rel: string, manifestPath: string): Promise<ModInfo> {
  let parsed: ParsedManifest
  try {
    const raw = await readJsonLenient(manifestPath)
    parsed = parseManifest(raw)
  } catch (e) {
    parsed = { name: path.basename(rel).replace(/^\.+/, ''), author: '', version: '', description: '', uniqueId: '', kind: 'unknown', dependencies: [], updateKeys: [], errors: [`manifest.json could not be parsed: ${errorMessage(e)}`] }
  }
  const stats = await dirStats(folderPath)
  const normalized = normalizeModFolder(rel)
  return {
    folder: toPosix(rel),
    folderPath,
    enabled: !isDisabledFolder(rel),
    name: parsed.name,
    author: parsed.author,
    version: parsed.version,
    description: parsed.description,
    uniqueId: parsed.uniqueId,
    kind: parsed.kind,
    contentPackFor: parsed.contentPackFor,
    entryDll: parsed.entryDll,
    minimumApiVersion: parsed.minimumApiVersion,
    minimumGameVersion: parsed.minimumGameVersion,
    dependencies: parsed.dependencies,
    updateKeys: parsed.updateKeys,
    hasConfig: await exists(path.join(folderPath, 'config.json')),
    manifestErrors: parsed.errors,
    sizeBytes: stats.sizeBytes,
    fileCount: stats.fileCount,
    isBundled: BUNDLED_MOD_IDS.has(parsed.uniqueId.toLowerCase()) || (!normalized.includes('/') && BUNDLED_MOD_FOLDERS.has(normalized.toLowerCase())),
    missingDependencies: []
  }
}

// Enable/disable by renaming the mod folder with a leading dot (SMAPI ignores dot-folders).
export async function setModEnabled(modsDir: string, folder: string, enabled: boolean): Promise<string> {
  const abs = safeJoin(modsDir, folder)
  const parent = path.dirname(abs)
  const name = path.basename(abs)
  const bare = name.replace(/^\.+/, '')
  const targetName = enabled ? bare : `.${bare}`
  if (targetName === name) return folder
  const target = path.join(parent, targetName)
  if (await exists(target)) {
    log.error(`Cannot ${enabled ? 'enable' : 'disable'} "${bare}" – "${targetName}" already exists`)
    throw new Error(`Cannot ${enabled ? 'enable' : 'disable'} "${bare}": "${targetName}" already exists.`)
  }
  await fs.rename(abs, target)
  log.info(`${enabled ? 'Enabled' : 'Disabled'} "${bare}"`, { detail: `renamed ${name} → ${targetName} in ${parent}` })
  const relParent = path.posix.dirname(toPosix(folder))
  return relParent === '.' ? targetName : `${relParent}/${targetName}`
}

// Find mod roots (folders with manifest.json) inside an extracted archive, without descending into found mods.
async function findModRoots(dir: string): Promise<string[]> {
  if (await findManifest(dir)) return [dir]
  const roots: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue
    roots.push(...(await findModRoots(path.join(dir, entry.name))))
  }
  return roots
}

// Install mods from zips (mod at the root, nested in a folder, or several per zip). An installed mod with the
// same UniqueID is replaced in place and keeps its config.json.
export async function installModZips(modsDir: string, zipPaths: string[], tempRoot: string): Promise<ModInstallResult> {
  const result: ModInstallResult = { installed: [], errors: [] }
  await ensureDir(modsDir)
  for (const zipPath of zipPaths) {
    const tmp = path.join(tempRoot, `install-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const zipName = path.basename(zipPath)
    try {
      log.info(`Installing from ${zipName}`, { detail: zipPath })
      await ensureDir(tmp)
      await extractZip(zipPath, tmp)
      const roots = await findModRoots(tmp)
      if (roots.length === 0) {
        log.error(`${zipName}: no manifest.json found in the archive`)
        result.errors.push(`${path.basename(zipPath)}: no manifest.json found in archive`)
        continue
      }
      if (roots.length > 1) log.info(`${zipName} contains ${roots.length} mods`)
      const installed = await scanMods(modsDir)
      for (const root of roots) {
        const manifestPath = await findManifest(root)
        const parsed = parseManifest(await readJsonLenient(manifestPath!))
        const desiredName = root === tmp ? path.basename(zipPath).replace(/\.zip$/i, '') : path.basename(root)
        const existing = parsed.uniqueId ? installed.find((m) => m.uniqueId.toLowerCase() === parsed.uniqueId.toLowerCase()) : undefined
        let target: string
        if (existing) {
          target = existing.folderPath
          const oldConfig = await readText(path.join(target, 'config.json'))
          await rmrf(target)
          await copyDir(root, target)
          // The user's settings win over the archive's defaults.
          if (oldConfig != null) await writeFileAtomic(path.join(target, 'config.json'), oldConfig)
          result.installed.push(`${parsed.name} ${parsed.version} (updated ${existing.version})`)
          log.info(`Updated "${parsed.name}" ${existing.version} → ${parsed.version}`, { detail: `${parsed.uniqueId} in ${target}` })
        } else {
          target = path.join(modsDir, desiredName)
          let n = 2
          while (await exists(target)) target = path.join(modsDir, `${desiredName} (${n++})`)
          await copyDir(root, target)
          result.installed.push(`${parsed.name} ${parsed.version}`)
          log.info(`Installed "${parsed.name}" ${parsed.version}`, { detail: `${parsed.uniqueId} in ${target}` })
        }
      }
    } catch (e) {
      log.fail(`Installing ${zipName} failed`, e)
      result.errors.push(`${path.basename(zipPath)}: ${errorMessage(e)}`)
    } finally {
      await rmrf(tmp).catch(() => undefined)
    }
  }
  return result
}

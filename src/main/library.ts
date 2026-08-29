import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LibraryEntry } from '../shared/types'
import { logScope } from './activity'
import { scanMods } from './mods'
import { dirStats, ensureDir, isDir, readJson, rmrf, writeJson } from './util/fs'

// Logged as 'mods': this is mod file management, and LogSource is a fixed union the Activity page filters on.
const log = logScope('mods')

const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const LIBRARY_DIR = 'mod-library'

// Mod IDs and versions end up in path names – keep them to what every filesystem accepts.
function safeName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown'
}

interface IndexFile {
  entries: LibraryEntry[]
}

// Every mod version this computer has ever installed, kept outside the game folder and shared by all profiles, so a
// profile switch or roll-back copies from disk instead of a new download. Layout: mod-library/<uniqueId>/<version>/.
export class ModLibrary {
  private readonly dir: string
  private readonly indexFile: string
  private entries: LibraryEntry[] | null = null

  constructor(deps: { userData: string }) {
    this.dir = path.join(deps.userData, LIBRARY_DIR)
    this.indexFile = path.join(this.dir, 'index.json')
  }

  private async load(): Promise<LibraryEntry[]> {
    if (!this.entries) {
      this.entries = (await readJson<IndexFile>(this.indexFile, { entries: [] })).entries
      await this.reconcile()
    }
    return this.entries
  }

  /**
   * Take in anything on disk the index does not know about. The files are the library; index.json is
   * only a cache of what they contain, and the two can drift – a lost or half-written index, or a
   * copy restored from a backup or another user-data folder. Without this the mods sit right there
   * on disk and the app reports an empty library.
   */
  private async reconcile(): Promise<void> {
    if (!(await isDir(this.dir))) return
    const entries = this.entries ?? []
    const known = new Set(entries.map((e) => `${safeName(e.id)}/${safeName(e.version)}`))
    const found: LibraryEntry[] = []

    for (const modDir of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!modDir.isDirectory()) continue
      const idDir = path.join(this.dir, modDir.name)
      // scanMods looks for manifests one level down, which is exactly the <id>/<version>/ layout.
      for (const mod of await scanMods(idDir)) {
        const versionDir = mod.folder.split('/')[0]
        if (known.has(`${modDir.name}/${versionDir}`)) continue
        if (!mod.uniqueId || !mod.version) continue
        const abs = path.join(idDir, versionDir)
        const stats = await dirStats(abs)
        const stat = await fs.stat(abs).catch(() => null)
        found.push({
          id: mod.uniqueId,
          version: mod.version,
          name: mod.name,
          folder: mod.folder.replace(/^\./, '') || modDir.name,
          addedAt: stat?.mtimeMs ?? Date.now(),
          sizeBytes: stats.sizeBytes
        })
      }
    }
    if (found.length === 0) return
    log.info(`Recovered ${found.length} mod version${found.length === 1 ? '' : 's'} that were on disk but missing from the library index`, {
      detail: found.map((f) => `${f.name} ${f.version}`).join(', ')
    })
    await this.save([...entries, ...found])
  }

  private async save(entries: LibraryEntry[]): Promise<void> {
    this.entries = entries
    await writeJson(this.indexFile, { entries } satisfies IndexFile)
  }

  private pathFor(id: string, version: string): string {
    return path.join(this.dir, safeName(id), safeName(version))
  }

  // Everything in the library, newest first per mod.
  async list(): Promise<LibraryEntry[]> {
    const entries = await this.load()
    return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || b.addedAt - a.addedAt)
  }

  // Every stored version of one mod, newest addition first.
  async listFor(id: string): Promise<LibraryEntry[]> {
    const entries = await this.load()
    return entries.filter((e) => e.id.toLowerCase() === id.toLowerCase()).sort((a, b) => b.addedAt - a.addedAt)
  }

  // Copy everything installed that the library lacks – run after zip installs and pulls, so every version
  // that ever reached the Mods folder stays available to other profiles.
  async capture(modsDir: string): Promise<LibraryEntry[]> {
    if (!(await isDir(modsDir))) return []
    const entries = await this.load()
    const added: LibraryEntry[] = []
    for (const mod of await scanMods(modsDir)) {
      if (mod.isBundled || !mod.uniqueId || !mod.version) continue
      const have = entries.some((e) => e.id.toLowerCase() === mod.uniqueId.toLowerCase() && e.version === mod.version)
      if (have) continue
      const dest = this.pathFor(mod.uniqueId, mod.version)
      try {
        await rmrf(dest)
        await ensureDir(path.dirname(dest))
        await fs.cp(mod.folderPath, dest, { recursive: true, filter: (p) => !JUNK.has(path.basename(p).toLowerCase()) })
        const stats = await dirStats(dest)
        added.push({
          id: mod.uniqueId,
          version: mod.version,
          name: mod.name,
          // The folder name the mod was installed under, without the dot that marks it disabled.
          folder: mod.folder.replace(/^\./, ''),
          addedAt: Date.now(),
          sizeBytes: stats.sizeBytes
        })
      } catch (e) {
        log.warn(`Could not add ${mod.name} ${mod.version} to the library`, { detail: String(e) })
      }
    }
    if (added.length > 0) {
      await this.save([...entries, ...added])
      log.info(`Added ${added.length} mod version${added.length === 1 ? '' : 's'} to the library`, { detail: added.map((a) => `${a.name} ${a.version}`).join(', ') })
    }
    return added
  }

  // Put a stored version into the Mods folder in place of the installed copy – folder name and enabled state
  // of the current install are kept, so only the files change.
  async install(id: string, version: string, modsDir: string): Promise<LibraryEntry> {
    const entry = (await this.listFor(id)).find((e) => e.version === version)
    if (!entry) throw new Error(`${id} ${version} is not in the library.`)
    const src = this.pathFor(id, version)
    if (!(await isDir(src))) throw new Error(`The library copy of ${entry.name} ${version} is gone from disk.`)

    const installed = (await scanMods(modsDir)).find((m) => m.uniqueId.toLowerCase() === id.toLowerCase())
    // Keep the existing folder (and its leading dot when the mod is switched off); otherwise use the name it
    // was stored under. A version swap must never enable a mod the profile has disabled.
    const folder = installed ? installed.folder : entry.folder
    const dest = path.join(modsDir, ...folder.split('/'))
    await rmrf(dest)
    await fs.cp(src, dest, { recursive: true })
    log.info(`Installed ${entry.name} ${version} from the library`, { detail: dest })
    return entry
  }

  // Drop one stored version (never touches what is installed).
  async remove(id: string, version: string): Promise<void> {
    const entries = await this.load()
    await rmrf(this.pathFor(id, version))
    await this.save(entries.filter((e) => !(e.id.toLowerCase() === id.toLowerCase() && e.version === version)))
    log.info(`Removed ${id} ${version} from the library`)
  }
}

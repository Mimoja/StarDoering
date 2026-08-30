import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ModsChangeEvent } from '../shared/types'
import { logScope } from './activity'
import { errorMessage, isDir, readText } from './util/fs'

const log = logScope('mods')
const SETTLE_MS = 500

interface Snapshot {
  folders: Set<string>
  // Relative config.json path → content hash.
  configs: Map<string, string>
}

// Same notion of "changed" as the server config view: line endings and surrounding whitespace do not count.
function hash(text: string): string {
  return createHash('sha1').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
}

// Mod folders and their config.json hashes, one grouping level deep (Mods/<Folder>/ and Mods/<Group>/<Folder>/).
async function scan(dir: string): Promise<Snapshot> {
  const folders = new Set<string>()
  const configs = new Map<string, string>()
  const add = async (rel: string): Promise<void> => {
    const text = await readText(path.join(dir, rel)).catch(() => null)
    if (text != null) configs.set(rel, hash(text))
  }
  for (const top of await listDirs(dir)) {
    folders.add(top)
    await add(`${top}/config.json`)
    for (const sub of await listDirs(path.join(dir, top))) await add(`${top}/${sub}/config.json`)
  }
  return { folders, configs }
}

function names(list: string[]): string {
  return list.length > 5 ? `${list.slice(0, 5).join(', ')} +${list.length - 5}` : list.join(', ')
}

// Watches the Mods folder for the game saving a config.json (GMCM) and for mod folders appearing or vanishing.
// A burst of events ends in one rescan diffed against the last, so identical rewrites stay silent.
export class ModsWatcher {
  private dir: string | null = null
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private last: Snapshot = { folders: new Set(), configs: new Map() }

  constructor(private readonly deps: { modsDir: () => Promise<string | null>; emit: (e: ModsChangeEvent) => void }) {}

  async sync(): Promise<void> {
    const dir = await this.deps.modsDir().catch(() => null)
    if (dir === this.dir) return
    this.stop()
    this.dir = dir
    if (!dir || !(await isDir(dir))) {
      this.dir = null
      return
    }
    this.last = await scan(dir)
    try {
      this.watcher = watch(dir, { recursive: true, persistent: false }, () => this.touch())
    } catch (e) {
      log.debug(`Cannot watch ${dir}: ${errorMessage(e)}`)
      this.dir = null
      return
    }
    this.watcher.on('error', () => this.stop())
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dir = null
  }

  private touch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.rescan().catch((e) => log.debug(`Mods watcher: ${errorMessage(e)}`)), SETTLE_MS)
  }

  private async rescan(): Promise<void> {
    if (!this.dir) return
    const prev = this.last
    const next = await scan(this.dir)
    this.last = next
    const folders = [...new Set([...prev.folders, ...next.folders])].filter((f) => prev.folders.has(f) !== next.folders.has(f)).sort()
    // A vanished folder takes its config with it – that is a folder change, not a settings change.
    const configs = [...new Set([...prev.configs.keys(), ...next.configs.keys()])]
      .filter((rel) => prev.configs.get(rel) !== next.configs.get(rel) && next.folders.has(rel.slice(0, rel.indexOf('/'))))
      .map((rel) => path.posix.dirname(rel))
      .sort()
    if (!folders.length && !configs.length) return
    if (configs.length) log.info(`Settings changed on disk: ${names(configs)} (config.json)`)
    if (folders.length) log.info(`Mod folders changed: ${names(folders)}`)
    this.deps.emit({ configs, folders })
  }
}

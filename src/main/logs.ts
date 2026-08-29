import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { SmapiLog } from '../shared/types'
import { errorMessage } from './util/fs'

const DEFAULT_TAIL = 256 * 1024

// Live view of SMAPI-latest.txt. SMAPI rewrites the file on every game start, so the parent folder is watched
// (a watcher on the file dies with the old inode); every debounced emission carries a fresh tail.
export class LogService {
  private watcher: FSWatcher | null = null
  private fileWatcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private lastStat: string | null = null
  private timer: NodeJS.Timeout | null = null
  private watchedPath: string | null = null

  constructor(
    private readonly deps: {
      // Resolve the current log path (null when the game data folder is unknown).
      logPath: () => Promise<string | null>
      emit: (log: SmapiLog) => void
    }
  ) {}

  async read(maxBytes = DEFAULT_TAIL): Promise<SmapiLog> {
    const p = await this.deps.logPath()
    if (!p) return { path: null, text: '', size: 0, truncated: false, missing: true }
    let handle: fs.FileHandle | null = null
    try {
      handle = await fs.open(p, 'r')
      const { size } = await handle.stat()
      const want = Math.max(1024, Math.min(maxBytes, 8 * 1024 * 1024))
      const start = Math.max(0, size - want)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      let text = buf.toString('utf8')
      if (start > 0) {
        const nl = text.indexOf('\n') // begin at a line boundary
        if (nl >= 0) text = text.slice(nl + 1)
      }
      return { path: p, text, size, truncated: start > 0, missing: false }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: p, text: '', size: 0, truncated: false, missing: true }
      return { path: p, text: `Could not read the log: ${errorMessage(e)}`, size: 0, truncated: false, missing: false }
    } finally {
      await handle?.close()
    }
  }

  async watch(maxBytes = DEFAULT_TAIL): Promise<void> {
    const p = await this.deps.logPath()
    if (!p || this.watchedPath === p) return
    this.unwatch()
    const dir = path.dirname(p)
    await fs.mkdir(dir, { recursive: true })
    const file = path.basename(p)
    const bump = (): void => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        void this.read(maxBytes).then((log) => this.deps.emit(log))
      }, 300)
    }
    // Three sources, because no single one works everywhere: on macOS a directory watcher only sees files
    // being created/removed/renamed (SMAPI rewrites the log at start), not lines appended to an existing
    // file – that needs a watcher on the file itself, re-armed whenever the file is replaced. A slow stat
    // poll backs both up (network folders, editors that replace files, watcher limits).
    try {
      this.watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name && name !== file) return
        this.armFileWatcher(p, bump)
        bump()
      })
      this.watcher.on('error', () => this.unwatch())
      this.armFileWatcher(p, bump)
      this.poll = setInterval(() => {
        void fs
          .stat(p)
          .then((st) => {
            const key = `${st.size}:${st.mtimeMs}`
            if (key !== this.lastStat) {
              this.lastStat = key
              bump()
            }
          })
          .catch(() => undefined)
      }, 1500)
      this.watchedPath = p
    } catch {
      this.unwatch()
    }
  }

  /** Watch the log file itself (kqueue/inotify fire on appends); replaced when SMAPI recreates the file. */
  private armFileWatcher(p: string, bump: () => void): void {
    this.fileWatcher?.close()
    this.fileWatcher = null
    try {
      this.fileWatcher = watch(p, { persistent: false }, () => bump())
      this.fileWatcher.on('error', () => {
        this.fileWatcher?.close()
        this.fileWatcher = null
      })
    } catch {
      this.fileWatcher = null // file not there yet – the directory watcher re-arms us when it appears
    }
  }

  unwatch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.lastStat = null
    this.fileWatcher?.close()
    this.fileWatcher = null
    this.watcher?.close()
    this.watcher = null
    this.watchedPath = null
  }
}

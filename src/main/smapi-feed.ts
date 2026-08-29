import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { LogLevel } from '../shared/types'
import { activityLog } from './activity'

// Read at most this much of the tail on each change.
const TAIL_BYTES = 256 * 1024
// Lines shown from what the game already wrote before StarDöring started.
const BACKFILL_LINES = 80
// A rewritten (or wildly grown) log must not flood the buffer in one go.
const MAX_BURST = 400

// "[08:12:34 ERROR SMAPI] Something went wrong" – SMAPI's line format.
const HEADER = /^\[(\d\d):(\d\d):(\d\d)\s+([A-Z]+)\s+([^\]]+)\]\s?(.*)$/

const LEVELS: Record<string, LogLevel> = { ERROR: 'error', ALERT: 'warn', WARN: 'warn', INFO: 'info', DEBUG: 'debug', TRACE: 'debug' }

interface Pending {
  level: LogLevel
  at: number
  message: string
  detail: string[]
}

// SMAPI's log merged into the activity log, INFO and above only – a game start writes thousands of TRACE lines.
// The folder is watched, not the file: SMAPI replaces it on every game start and a watcher on the old inode goes deaf.
export class SmapiLogFeed {
  private watcher: FSWatcher | null = null
  private fileWatcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private lastStat: string | null = null
  private timer: NodeJS.Timeout | null = null
  private watched: string | null = null
  private size = 0
  private started = false

  constructor(private readonly deps: { logPath: () => Promise<string | null> }) {}

  // Show what the game logged recently, then follow it. Never throws – the feed is a convenience.
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.pump(BACKFILL_LINES)
      await this.watch()
    } catch {
      // no log yet, or an unreadable folder – nothing to follow
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.lastStat = null
    this.fileWatcher?.close()
    this.fileWatcher = null
    this.watcher?.close()
    this.watcher = null
    this.watched = null
    this.started = false
  }

  private async watch(): Promise<void> {
    const p = await this.deps.logPath()
    if (!p || this.watched === p) return
    const dir = path.dirname(p)
    await fs.mkdir(dir, { recursive: true })
    const file = path.basename(p)
    try {
      const bump = (): void => {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.pump(MAX_BURST).catch(() => undefined)
        }, 400)
      }
      // A directory watcher alone misses appends on macOS (kqueue on a folder only reports entries coming
      // and going), so the file itself is watched too – re-armed when SMAPI recreates it – with a slow stat
      // poll as the fallback that works everywhere.
      this.watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name && name !== file) return
        this.armFileWatcher(p, bump)
        bump()
      })
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
      this.watcher.on('error', () => this.stop())
      this.watched = p
    } catch {
      this.stop()
    }
  }

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
      this.fileWatcher = null // not there yet – the directory watcher re-arms us when it appears
    }
  }

  // Read what was appended since the last pump and turn it into activity entries.
  private async pump(maxLines: number): Promise<void> {
    const p = await this.deps.logPath()
    if (!p) return
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(p, 'r')
      const { size } = await handle.stat()
      if (size === this.size) return
      const restarted = size < this.size // SMAPI truncates the file when the game starts
      const want = Math.min(TAIL_BYTES, size)
      const buf = Buffer.alloc(want)
      await handle.read(buf, 0, want, size - want)

      // Everything appended since the last read, as long as it is still inside the tail we just read.
      const added = restarted || this.size === 0 ? want : Math.min(size - this.size, want)
      let text = buf.subarray(want - added).toString('utf8')
      this.size = size
      if (added === want && size > want) {
        const nl = text.indexOf('\n') // the window may start mid-line
        if (nl >= 0) text = text.slice(nl + 1)
      }
      if (restarted) activityLog.write('info', 'smapi', 'The game started writing a new SMAPI log')
      this.emit(text, maxLines)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    } finally {
      await handle?.close()
    }
  }

  private emit(text: string, maxLines: number): void {
    const lines = text.split('\n')
    const entries: Pending[] = []
    let pending: Pending | null = null
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      const m = HEADER.exec(line)
      if (m) {
        if (pending) entries.push(pending)
        const level = LEVELS[m[4].toUpperCase()] ?? 'info'
        const at = new Date()
        at.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0)
        pending = { level, at: at.getTime(), message: `${m[5].trim()}: ${m[6].trim()}`.replace(/:\s*$/, ''), detail: [] }
      } else if (pending && line.trim()) {
        pending.detail.push(line) // continuation of the entry above (stack traces)
      }
    }
    if (pending) entries.push(pending)

    // TRACE/DEBUG is the bulk of a SMAPI log; the merged view keeps what a player can act on.
    const keep = entries.filter((e) => e.level !== 'debug').slice(-maxLines)
    for (const e of keep) {
      activityLog.write(e.level, 'smapi', e.message, { at: e.at, detail: e.detail.length > 0 ? e.detail.join('\n') : undefined })
    }
  }
}

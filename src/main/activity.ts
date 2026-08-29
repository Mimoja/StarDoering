import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LogEntry, LogFileInfo, LogLevel, LogSource } from '../shared/types'
import { errorMessage } from './util/fs'

const MAX_ENTRIES = 3000
const MAX_FILE_BYTES = 4 * 1024 * 1024
// Entries are pushed to the renderer in batches – a clone logs hundreds of lines in a second.
const FLUSH_MS = 120
const MAX_MESSAGE = 2000
const MAX_DETAIL = 8000

const PAD: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }

// Credentials never belong in a log the user can copy out of the window: URLs with an embedded password,
// access tokens and anything that calls itself a token/passphrase are masked.
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/([?&](?:key|apikey|api_key|access_token|token|password)=)[^&\s]+/gi, '$1***')
    .replace(/\b(pass(?:phrase|word)|token|secret)(["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1$2***')
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s
}

// Turn whatever a caller passes as detail into text: errors keep their stack, objects are JSON.
export function describeDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined
  let text: string
  if (typeof detail === 'string') text = detail
  else if (detail instanceof Error) text = detail.stack ?? `${detail.name}: ${detail.message}`
  else if (Array.isArray(detail)) text = detail.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('\n')
  else {
    try {
      text = JSON.stringify(detail, null, 2)
    } catch {
      text = String(detail)
    }
  }
  const trimmed = redact(text).trim()
  return trimmed ? clip(trimmed, MAX_DETAIL) : undefined
}

export interface LogOptions {
  // Command output, stack trace, change list – anything too long for the message line.
  detail?: unknown
  durationMs?: number
  // When the event happened, if that is not "now" (SMAPI lines carry the game's own clock).
  at?: number
}

// What every module logs through: `const log = logScope('git')`.
export interface LogScope {
  debug(message: string, opts?: LogOptions): void
  info(message: string, opts?: LogOptions): void
  warn(message: string, opts?: LogOptions): void
  error(message: string, opts?: LogOptions): void
  // Log a caught failure: "<message>: <error message>", with the stack as detail.
  fail(message: string, e: unknown, opts?: LogOptions): void
}

// The app's own log: one ring buffer every part of the main process writes to, mirrored to a file and streamed to
// the Activity page. Deliberately free of Electron imports so the smoke scripts can bundle the modules that log.
class ActivityLog {
  private entries: LogEntry[] = []
  private seq = 0
  private sink: ((entries: LogEntry[]) => void) | null = null
  private pending: LogEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private file: string | null = null
  private fileBytes = 0
  private writes: Promise<void> = Promise.resolve()
  private toConsole = true

  // Called once the app knows its user data folder; buffered entries are flushed into the file.
  configure(opts: { file?: string | null; console?: boolean }): void {
    if (opts.console != null) this.toConsole = opts.console
    if (opts.file === undefined) return
    this.file = opts.file
    if (!this.file) return
    const backlog = [...this.entries]
    this.queueWrite(async (file) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      this.fileBytes = await fs
        .stat(file)
        .then((s) => s.size)
        .catch(() => 0)
      await this.append(file, backlog.map(formatLine).join(''))
    })
  }

  // Stream new entries to the renderer; returns an unsubscribe.
  onEntries(sink: (entries: LogEntry[]) => void): () => void {
    this.sink = sink
    return () => {
      if (this.sink === sink) this.sink = null
    }
  }

  // Newest `limit` entries, oldest first (the order the viewer renders them in).
  list(limit = MAX_ENTRIES): LogEntry[] {
    const n = Math.max(1, Math.min(limit, MAX_ENTRIES))
    return this.entries.slice(-n)
  }

  clear(): void {
    this.entries = []
    this.pending = []
  }

  async fileInfo(): Promise<LogFileInfo> {
    if (!this.file) return { path: '', exists: false, sizeBytes: 0 }
    const size = await fs
      .stat(this.file)
      .then((s) => s.size)
      .catch(() => -1)
    return { path: this.file, exists: size >= 0, sizeBytes: Math.max(0, size) }
  }

  write(level: LogLevel, source: LogSource, message: string, opts: LogOptions = {}): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      at: Date.now(),
      level,
      source,
      message: clip(redact(String(message ?? '')).trim(), MAX_MESSAGE)
    }
    if (opts.at != null && Number.isFinite(opts.at)) entry.at = opts.at
    const detail = describeDetail(opts.detail)
    if (detail) entry.detail = detail
    if (opts.durationMs != null && Number.isFinite(opts.durationMs)) entry.durationMs = Math.round(opts.durationMs)

    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.mirror(entry)
    this.queueWrite((file) => this.append(file, formatLine(entry)))
    this.pending.push(entry)
    this.scheduleFlush()
    return entry
  }

  scope(source: LogSource): LogScope {
    return {
      debug: (message, opts) => void this.write('debug', source, message, opts),
      info: (message, opts) => void this.write('info', source, message, opts),
      warn: (message, opts) => void this.write('warn', source, message, opts),
      error: (message, opts) => void this.write('error', source, message, opts),
      fail: (message, e, opts) =>
        void this.write('error', source, `${message}: ${errorMessage(e)}`, { ...opts, detail: opts?.detail ?? (e instanceof Error ? e.stack : undefined) })
    }
  }

  private scheduleFlush(): void {
    if (this.timer || !this.sink) return
    this.timer = setTimeout(() => {
      this.timer = null
      const batch = this.pending
      this.pending = []
      if (batch.length > 0) this.sink?.(batch)
    }, FLUSH_MS)
    this.timer.unref?.()
  }

  private mirror(entry: LogEntry): void {
    if (!this.toConsole) return
    const line = `[${entry.source}] ${entry.message}`
    if (entry.level === 'error') console.error(line)
    else if (entry.level === 'warn') console.warn(line)
    else console.log(line)
  }

  private queueWrite(fn: (file: string) => Promise<void>): void {
    this.writes = this.writes.then(async () => {
      if (!this.file) return
      try {
        await fn(this.file)
      } catch {
        // the log file is a convenience – never let it break the app
      }
    })
  }

  // Append, rotating to <file>.1 once the file grows past the limit.
  private async append(file: string, text: string): Promise<void> {
    if (!text) return
    if (this.fileBytes > MAX_FILE_BYTES) {
      await fs.rename(file, `${file}.1`).catch(() => undefined)
      this.fileBytes = 0
    }
    await fs.appendFile(file, text, 'utf8')
    this.fileBytes += Buffer.byteLength(text)
  }
}

function formatLine(e: LogEntry): string {
  const head = `${new Date(e.at).toISOString()} ${PAD[e.level]} ${e.source.padEnd(7)} ${e.message}${e.durationMs != null ? ` (${e.durationMs} ms)` : ''}\n`
  const detail = e.detail ? `${e.detail.replace(/^/gm, '    ')}\n` : ''
  return head + detail
}

export const activityLog = new ActivityLog()

// The logger for one part of the app.
export function logScope(source: LogSource): LogScope {
  return activityLog.scope(source)
}

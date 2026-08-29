import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogFileInfo, LogLevel, LogSource } from '@shared/types'
import LogViewer from './LogViewer'
import { Button, Empty, ErrorBox, Modal } from './ui'
import { api, errorText, formatBytes } from '../lib/hooks'
import { clearActivity, useActivityEntries, useActivityError } from '../lib/activity-store'

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']
const SOURCES: LogSource[] = ['app', 'game', 'smapi', 'git', 'mods', 'modlist', 'sync', 'catalog']
// What each source covers, for the filter chip's tooltip.
const SOURCE_HINT: Record<LogSource, string> = {
  app: 'the app itself',
  game: 'starting Stardew Valley and installing SMAPI',
  git: 'every git command, clone, fetch and push',
  mods: 'installing, enabling and disabling mods',
  modlist: 'mod pages and version lookups',
  sync: 'pulling and pushing the server config',
  catalog: 'the downloaded mod catalog',
  smapi: 'the game\'s own log – what SMAPI and the mods report while you play (info and above)'
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour12: false })

function asText(entries: LogEntry[]): string {
  return entries
    .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} ${e.source} ${e.message}${e.durationMs != null ? ` (${e.durationMs} ms)` : ''}${e.detail ? `\n${e.detail.replace(/^/gm, '    ')}` : ''}`)
    .join('\n')
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

// StarDöring's own log as it happens. `compact` is the sidebar panel: the same entries, one line each, with a button
// that opens the full view. Both read the same store, so they never drift apart.
export default function ActivityLog({ compact = false, notify, onMaximize }: { compact?: boolean; notify: (m: string) => void; onMaximize?: () => void }) {
  const entries = useActivityEntries()
  const error = useActivityError()
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set<LogLevel>(['info', 'warn', 'error']))
  const [sources, setSources] = useState<Set<LogSource>>(() => new Set(SOURCES))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const [follow, setFollow] = useState(true)
  const [file, setFile] = useState<LogFileInfo | null>(null)
  const [smapiOpen, setSmapiOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (compact) return
    let alive = true
    void api.activity
      .file()
      .then((f) => alive && setFile(f))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [compact])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (!levels.has(e.level) || !sources.has(e.source)) return false
      if (!q) return true
      return e.message.toLowerCase().includes(q) || e.source.includes(q) || (e.detail ?? '').toLowerCase().includes(q)
    })
  }, [entries, levels, sources, query])

  // Stay pinned to the newest entry unless the user scrolled up to read something.
  useEffect(() => {
    const el = box.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [rows, follow])

  const onScroll = (): void => {
    const el = box.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  const toggleDetail = (seq: number): void => setOpen((prev) => toggle(prev, seq))

  const clear = async (): Promise<void> => {
    try {
      await clearActivity()
    } catch (e) {
      notify(errorText(e))
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(asText(rows))
      notify(`Copied ${rows.length} log line${rows.length === 1 ? '' : 's'}`)
    } catch (e) {
      notify(errorText(e))
    }
  }

  const counts = useMemo(() => ({ errors: entries.filter((e) => e.level === 'error').length, warnings: entries.filter((e) => e.level === 'warn').length }), [entries])

  const list = (
    <div className={`log activity${compact ? ' compact' : ''}`} ref={box} onScroll={onScroll}>
      {rows.length === 0 && <Empty>{entries.length === 0 ? 'Nothing logged yet.' : 'No entry matches the filters.'}</Empty>}
      {rows.map((e) => (
        <div className={`act lvl-${e.level}${e.detail ? ' has-detail' : ''}`} key={e.seq}>
          <div className="act-head" onClick={() => e.detail && toggleDetail(e.seq)} title={compact ? `${time(e.at)} · ${e.source}${e.detail ? ' · click for details' : ''}` : undefined}>
            {!compact && <span className="act-time">{time(e.at)}</span>}
            {!compact && <span className="act-level">{e.level}</span>}
            <span className="act-source">{e.source}</span>
            <span className="act-message">
              {e.detail ? <span className="chev">{open.has(e.seq) ? '▾' : '▸'}</span> : null}
              {e.message}
              {e.durationMs != null && <span className="act-ms"> {e.durationMs} ms</span>}
            </span>
          </div>
          {e.detail && open.has(e.seq) && <pre className="act-detail">{e.detail}</pre>}
        </div>
      ))}
    </div>
  )

  if (compact) {
    return (
      <div className="sidebar-log">
        <header>
          <span>Activity</span>
          {counts.errors > 0 && <span className="bad">{counts.errors}</span>}
          <button className="log-max" title="Maximize the log" aria-label="Maximize the log" onClick={onMaximize}>
            ⤢
          </button>
        </header>
        {error && <div className="sub bad">{error}</div>}
        {list}
        {!follow && (
          <button className="log-jump" onClick={() => setFollow(true)}>
            ↓ newest
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}

      <div className="log-toolbar">
        <input className="grow" type="search" placeholder="Search messages…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips">
          {LEVELS.map((l) => (
            <button key={l} className={`chip lvl-${l}${levels.has(l) ? ' on' : ''}`} title={`Show ${l} messages`} onClick={() => setLevels(toggle(levels, l))}>
              {l}
            </button>
          ))}
        </div>
        <label className="row">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <Button variant="ghost" onClick={() => void copy()}>
          Copy
        </Button>
        <Button variant="ghost" onClick={() => void clear()}>
          Clear
        </Button>
        <Button variant="ghost" onClick={() => setSmapiOpen(true)}>
          SMAPI log
        </Button>
      </div>

      <div className="chips">
        <button className={`chip${sources.size === SOURCES.length ? ' on' : ''}`} title="Show every source" onClick={() => setSources(new Set(sources.size === SOURCES.length ? [] : SOURCES))}>
          all
        </button>
        {SOURCES.map((s) => (
          <button key={s} className={`chip${sources.has(s) ? ' on' : ''}`} title={SOURCE_HINT[s]} onClick={() => setSources(toggle(sources, s))}>
            {s}
          </button>
        ))}
      </div>

      <div className="sub log-meta">
        {rows.length} of {entries.length} entries
        {counts.errors > 0 && <span className="bad"> · {counts.errors} errors</span>}
        {counts.warnings > 0 && <span className="hint"> · {counts.warnings} warnings</span>}
        {file?.path && (
          <>
            {' · '}
            <button className="linkish" title={file.path} onClick={() => api.activity.openFile().catch((e) => notify(errorText(e)))}>
              log file{file.exists ? ` (${formatBytes(file.sizeBytes)})` : ''}
            </button>
          </>
        )}
      </div>

      {list}
      {!follow && (
        <button className="log-jump" onClick={() => setFollow(true)}>
          ↓ jump to the newest entry
        </button>
      )}

      {smapiOpen && (
        <Modal wide title="SMAPI log" onClose={() => setSmapiOpen(false)}>
          <LogViewer notify={notify} />
        </Modal>
      )}
    </>
  )
}

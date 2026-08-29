import { useEffect, useMemo, useRef, useState } from 'react'
import type { SmapiLog } from '@shared/types'
import { Button, ErrorBox } from './ui'
import { api, errorText, formatBytes } from '../lib/hooks'

// SMAPI writes a line like "[08:12:34 ERROR SMAPI] …" – pick the level out for colouring.
function levelOf(line: string): string {
  const m = /^\[\d\d:\d\d:\d\d\s+([A-Z]+)/.exec(line)
  switch (m?.[1]) {
    case 'ERROR':
      return 'bad'
    case 'WARN':
    case 'ALERT':
      return 'warn'
    case 'DEBUG':
    case 'TRACE':
      return 'muted'
    default:
      return ''
  }
}

// Live view of the SMAPI log: the main process tails the file and pushes a fresh tail on every change, so this only
// has to render and stay scrolled to the bottom.
export default function LogViewer({ notify }: { notify: (m: string) => void }) {
  const [log, setLog] = useState<SmapiLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const off = api.logs.onChange((l) => {
      if (alive) setLog(l)
    })
    void api.logs
      .read()
      .then((l) => {
        if (alive) setLog(l)
      })
      .catch((e) => alive && setError(errorText(e)))
    void api.logs.watch().catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
      off()
      void api.logs.unwatch().catch(() => undefined)
    }
  }, [])

  const lines = useMemo(() => {
    const all = (log?.text ?? '').split('\n')
    const q = filter.trim().toLowerCase()
    return q ? all.filter((l) => l.toLowerCase().includes(q)) : all
  }, [log?.text, filter])

  // Stay pinned to the newest line unless the user scrolled up to read something.
  useEffect(() => {
    const el = box.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const onScroll = (): void => {
    const el = box.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="log-toolbar">
        <input className="grow" type="search" placeholder="Filter lines…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="row">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <Button variant="ghost" onClick={() => api.game.openDir('logs').catch((e) => notify(errorText(e)))}>
          Open folder
        </Button>
      </div>

      <div className="sub log-meta">
        {log?.missing
          ? 'No SMAPI log yet – start the game once.'
          : log
            ? `${log.truncated ? `last ${formatBytes(log.text.length)} of ` : ''}${formatBytes(log.size)}${filter.trim() ? ` · ${lines.length} matching lines` : ''}`
            : 'Reading the log…'}
        {log?.path && <span className="mono"> · {log.path}</span>}
      </div>

      <div className="log" ref={box} onScroll={onScroll}>
        {lines.map((l, i) => (
          <div className={`log-line ${levelOf(l)}`} key={i}>
            {l || '\u00a0'}
          </div>
        ))}
      </div>
      {!follow && (
        <button className="log-jump" onClick={() => setFollow(true)}>
          ↓ jump to the newest line
        </button>
      )}
    </>
  )
}

import { useEffect, useRef } from 'react'
import type { SyncCommit, SyncGroup, SyncState } from '@shared/types'
import { Badge, Empty, ErrorBox, Section } from './ui'
import { changeClass, stripChangeIcon } from '../lib/changes'
import { api, formatDate, useAsync } from '../lib/hooks'

// Commit list of the active profile's repository; refreshes itself whenever a pull or push settles.
export default function VersionHistory({ profile, sync }: { profile: SyncGroup | null; sync: SyncState | null }) {
  const history = useAsync<SyncCommit[]>(() => (profile ? api.sync.history(profile.id, 30) : Promise.resolve([])), [profile?.id])
  const wasSyncing = useRef(false)

  useEffect(() => {
    const syncing = sync?.status === 'pulling' || sync?.status === 'pushing'
    if (wasSyncing.current && !syncing) void history.reload()
    wasSyncing.current = syncing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.status])

  if (!profile) return null
  const commits = history.data ?? []
  return (
    <Section title={history.loading ? 'Version history · refreshing…' : 'Version history'}>
      {history.error && <ErrorBox>{history.error}</ErrorBox>}
      {!history.loading && commits.length === 0 && <Empty>No commits yet – the history updates with every pull and push.</Empty>}
      {commits.length > 0 && (
        <div className="list">
          {commits.map((c) => (
            <div className="commit" key={c.hash}>
              <div className="commit-head">
                <span className="name">{c.subject}</span>
                {c.current && <Badge tone="ok">you are here</Badge>}
              </div>
              {c.details.length > 0 && (
                <ul className="commit-details">
                  {c.details.map((d, i) => (
                    <li className={changeClass(d)} key={`${c.hash}-${i}`}>
                      {stripChangeIcon(d)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="sub">
                <span className="mono">{c.hash}</span> · {c.author} · {formatDate(c.at)} · {c.filesChanged} file{c.filesChanged === 1 ? '' : 's'}
                {c.modsChanged.length ? ` · ${c.modsChanged.join(', ')}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

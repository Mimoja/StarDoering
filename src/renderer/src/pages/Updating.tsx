import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'
import { api } from '../lib/hooks'

// What the main window shows before the app: one line about what the start-up update is doing.
export default function Updating() {
  const [s, setS] = useState<UpdateState | null>(null)

  useEffect(() => {
    void api.update.state().then(setS).catch(() => undefined)
    return api.update.onState(setS)
  }, [])

  const busy = s?.phase === 'downloading' || s?.phase === 'installing' || s?.phase === 'restarting'
  const line = !s ? 'Checking for updates…' : s.phase === 'available' ? `StarDöring ${s.latestVersion} is available…` : s.phase === 'error' ? `Update failed: ${s.message}` : s.message || 'Checking for updates…'
  const percent = s?.phase === 'downloading' ? (s.total ? Math.round((s.received / s.total) * 100) : 0) : 100

  return (
    <div className="updater">
      <div className="updater-title">StarDöring {s?.currentVersion ?? ''}</div>
      <div className="updater-line" title={line}>
        {line}
      </div>
      {busy && (
        <div className="updater-bar">
          <div className="updater-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}

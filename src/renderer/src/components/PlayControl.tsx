import { useEffect, useState } from 'react'
import type { GameInfo, LaunchMode, SyncState } from '@shared/types'
import { api, errorText, useAsync, useBusy } from '../lib/hooks'
import { Badge, PlayButton, type PlayOption } from './ui'

// The Play control at the top of the sidebar. Self-contained: reads the game info itself, follows the game's exit and
// the window focus, and watches the sync state for the "pulling…" hint.
export default function PlayControl({ notify }: { notify: (message: string) => void }) {
  const info = useAsync<GameInfo>(() => api.game.getInfo())
  const [sync, setSync] = useState<SyncState | null>(null)
  const { busy, run } = useBusy(notify)

  useEffect(() => api.game.onExit(() => void info.reload()), [])
  useEffect(() => {
    void api.sync.state().then(setSync).catch(() => undefined)
    return api.sync.onState(setSync)
  }, [])
  useEffect(() => {
    const onFocus = (): void => void info.reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const g = info.data
  const running = g?.running ?? false
  const smapiInstalled = g?.smapi.installed ?? false

  const launch = (mode: LaunchMode) =>
    run(`launch-${mode}`, async () => {
      const r = await api.game.launch(mode)
      if (!r.ok) notify(r.error ?? 'Launch failed')
      else if (r.warning) notify(r.warning)
      else notify(mode === 'smapi' ? 'Launching Stardew Valley with SMAPI…' : mode === 'vanilla' ? 'Launching Stardew Valley without mods…' : 'Launching via Steam…')
      await info.reload()
    })

  const installSmapi = () =>
    run('smapi', async () => {
      const r = await api.game.installSmapi()
      notify(r.message)
      await info.reload()
    })

  const menu: PlayOption[] = [
    { label: 'Play without mods', hint: 'vanilla Stardew Valley', disabled: !g?.found || running, busy: busy === 'launch-vanilla', onSelect: () => void launch('vanilla') },
    { label: 'Play via Steam', hint: 'let Steam start the game', disabled: running, busy: busy === 'launch-steam', onSelect: () => void launch('steam') }
  ]

  return (
    <div className="sidebar-play">
      {g && !smapiInstalled ? (
        <PlayButton icon="⬇" menu={menu} busy={busy === 'smapi'} disabled={!g.found} hint={g.found ? 'SMAPI is needed to play with mods' : 'Game not found'} onClick={() => void installSmapi()}>
          Install SMAPI
        </PlayButton>
      ) : (
        <PlayButton
          menu={menu}
          busy={busy === 'launch-smapi'}
          disabled={!g || running || !smapiInstalled}
          hint={sync?.status === 'pulling' ? 'pulling the latest server config…' : running ? 'Stardew Valley is running' : g?.smapi.version ? `with SMAPI ${g.smapi.version}` : undefined}
          onClick={() => void launch('smapi')}
        >
          Play
        </PlayButton>
      )}
      {running && <Badge tone="info">running</Badge>}
      {info.error && <span className="sub" title={info.error}>{errorText(info.error)}</span>}
    </div>
  )
}

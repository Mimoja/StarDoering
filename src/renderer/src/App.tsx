import { useEffect, useState, useRef } from 'react'
import type { AppSettings, DeepLinkAddProfile, DeepLinkEvent, ServerConfigView, SyncGroup, SyncState } from '@shared/types'
import ActivityLog from './components/ActivityLog'
import AddProfileLink from './components/AddProfileLink'
import PlayControl from './components/PlayControl'
import Dashboard from './pages/Dashboard'
import Mods from './pages/Mods'
import ModConfig from './pages/ModConfig'
import AddMod from './pages/AddMod'
import Saves from './pages/Saves'
import { Button, Modal } from './components/ui'
import { api, errorText, pullSummary, useAsync, type AsyncState } from './lib/hooks'

type Tab = 'dashboard' | 'mods' | 'add' | 'config' | 'saves'

const SIDEBAR_DEFAULT = 240
const SIDEBAR_MIN = 190
const SIDEBAR_MAX = 460
const SIDEBAR_KEY = 'stardoring.sidebarWidth'

const clampSidebar = (w: number): number => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_KEY))
    if (Number.isFinite(raw) && raw > 0) return clampSidebar(raw)
  } catch {
    // storage unavailable – use the default
  }
  return SIDEBAR_DEFAULT
}

function storeSidebarWidth(w: number): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(w))
  } catch {
    // not persisting is fine
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'mods', label: 'Mods' },
  { id: 'add', label: 'Add a mod' },
  { id: 'config', label: 'Mod config' },
  { id: 'saves', label: 'Saves' }
]

// The active profile's server config, kept for the whole session: pages come and go with the tabs, this does not,
// so switching to Mods shows the list instead of a loading page.
export interface ServerConfigState extends AsyncState<ServerConfigView> {
  // A background fetch is in flight (the view on screen stays usable meanwhile).
  checking: boolean
  // Re-read from the remote over the network and swap the fresher view in.
  check: () => Promise<void>
}

// Every page works on the profile picked in the sidebar.
export interface PageProps {
  notify: (m: string) => void
  // The active server config (git repository), or null when playing with local mods only.
  profile: SyncGroup | null
  // Every profile on this computer.
  profiles: SyncGroup[]
  // Switch the active profile; asks first when the current one has unpushed changes.
  selectProfile: (id: string) => Promise<void>
  // Reload the sidebar's profile list – call after adding, editing or removing a repository.
  reloadProfiles: () => Promise<void>
  // Global pull/push state of the active profile, kept live by the sidebar.
  sync: SyncState | null
  // The active profile's server config, loaded at start and refreshed in the background.
  config: ServerConfigState
}

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [version, setVersion] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const groups = useAsync(() => api.sync.listGroups())
  const settings = useAsync(() => api.settings.get())
  const [switching, setSwitching] = useState(false)
  // A profile switch waiting on the user's answer about the current profile's unpushed changes.
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; name: string } | null>(null)
  const [pushingBeforeSwitch, setPushingBeforeSwitch] = useState(false)
  const [sync, setSync] = useState<SyncState | null>(null)
  // Profile a stardoering:// link proposes, waiting for the user's yes.
  const [deepLink, setDeepLink] = useState<DeepLinkAddProfile | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    void api.app.version().then(setVersion).catch(() => undefined)
    void api.sync.state().then(setSync).catch(() => undefined)
    const offState = api.sync.onState(setSync)
    // Pulls nobody clicked (switch, start, Play) get a toast; 'manual' callers toast their own result.
    const offPull = api.serverConfig.onPull((r) => {
      if (r.trigger !== 'manual') setToast(pullSummary(r))
    })
    const offExit = api.game.onExit((info) => setToast(`Game exited${info.code != null ? ` (code ${info.code})` : ''}`))
    // stardoering:// links: one that arrived while we were running comes over the event, one that started
    // the app is queued in the main process until this asks for it.
    const openLink = (e: DeepLinkEvent): void => ('error' in e ? setToast(e.error) : setDeepLink(e.link))
    const offLink = api.app.onDeepLink(openLink)
    void api.app
      .takeDeepLink()
      .then((e) => e && openLink(e))
      .catch(() => undefined)
    return () => {
      offState()
      offPull()
      offExit()
      offLink()
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const activeId = settings.data?.activeGroupId ?? null
  const profile = groups.data?.find((g) => g.id === activeId) ?? null

  // Read from the local clone at start (and on profile change), then bring it up to date over the network in the
  // background. Living here rather than in the Mods page means a tab switch re-renders a list we already have.
  const config = useAsync<ServerConfigView>(() => api.serverConfig.view({ fetch: false }), [activeId])
  const [checking, setChecking] = useState(false)
  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      config.setData(await api.serverConfig.view({ fetch: true }))
    } catch {
      // offline or git trouble – the local view stays usable, the sync state carries the reason
    } finally {
      setChecking(false)
    }
  }
  // A profile switch (and the start-up pull) fetch in the background: once that pull settles, re-read the
  // freshly updated local clone – instantly, without another fetch – so the pages update on changes.
  const lastSyncStatus = useRef<SyncState['status'] | null>(null)
  useEffect(() => {
    const prev = lastSyncStatus.current
    lastSyncStatus.current = sync?.status ?? null
    const settledAfterPull = (prev === 'pulling' || prev === 'pushing') && sync?.status !== 'pulling' && sync?.status !== 'pushing'
    if (settledAfterPull && activeId) void api.serverConfig.view({ fetch: false }).then((v) => config.setData(v)).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.status])

  // The game saving a config.json (GMCM), a mod folder appearing or vanishing, the game exiting: re-read the local
  // clone against the Mods folder – no fetch – so "config ↑" and the unpushed state follow what is on disk.
  useEffect(() => {
    const reread = (): void => {
      if (activeId) void api.serverConfig.view({ fetch: false }).then((v) => config.setData(v)).catch(() => undefined)
    }
    const offMods = api.mods.onChange(reread)
    const offExit = api.game.onExit(reread)
    return () => {
      offMods()
      offExit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const reloadProfiles = async (): Promise<void> => {
    await groups.reload()
    settings.setData(await api.settings.get())
  }

  const applySwitch = async (id: string): Promise<void> => {
    setSwitching(true)
    try {
      const next: AppSettings = await api.serverConfig.setActive(id || null)
      settings.setData(next)
    } catch (e) {
      setToast(errorText(e))
    } finally {
      setSwitching(false)
    }
  }

  // Switching takes nothing out of the Mods folder, so there is nothing to warn about up front – except
  // work that has not reached the repository yet. Ask about that, and let the user pick what happens to it.
  const selectProfile = async (id: string): Promise<void> => {
    if (id !== activeId && activeId && config.data?.unpushed) {
      setPendingSwitch({ id, name: groups.data?.find((g) => g.id === id)?.name ?? (id ? 'that profile' : 'Local mods only') })
      return
    }
    await applySwitch(id)
  }

  const pushThenSwitch = async (): Promise<void> => {
    if (!pendingSwitch) return
    const target = pendingSwitch.id
    setPushingBeforeSwitch(true)
    try {
      const r = await api.serverConfig.push()
      setToast(r.message)
      setPendingSwitch(null)
      await applySwitch(target)
    } catch (e) {
      setToast(errorText(e)) // the dialog stays open so "Switch anyway" is still there
    } finally {
      setPushingBeforeSwitch(false)
    }
  }

  const resync = async (): Promise<void> => {
    // resync() never throws: failures land in the sync state instead.
    const r = await api.sync.resync()
    if (r) setToast(pullSummary(r))
  }

  const busy = sync?.status === 'pulling' || sync?.status === 'pushing'
  const syncTone = sync?.status === 'error' ? ' bad' : sync?.status === 'offline' ? ' offline' : ''

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizing(true)
  }
  const onResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (resizing) setSidebarWidth(clampSidebar(e.clientX))
  }
  const endResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setResizing(false)
    storeSidebarWidth(sidebarWidth)
  }
  const resetSidebar = (): void => {
    setSidebarWidth(SIDEBAR_DEFAULT)
    storeSidebarWidth(SIDEBAR_DEFAULT)
  }

  const pageProps: PageProps = { notify: setToast, profile, profiles: groups.data ?? [], selectProfile, reloadProfiles, sync, config: { ...config, checking, check } }

  return (
    <div className={`layout${resizing ? ' resizing' : ''}`}>
      <nav className="sidebar" style={{ width: sidebarWidth }}>
        <div className="brand">StarDöring</div>
        <PlayControl notify={setToast} />

        <label className="profile">
          <span>Profile</span>
          <div className="profile-pick">
            <select
              value={activeId ?? ''}
              title={profile?.name ?? 'Local mods only'}
              disabled={switching || groups.loading}
              onChange={(e) => void selectProfile(e.target.value)}
            >
              <option value="">Local mods only</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button
              className={`resync${busy ? ' spinning' : ''}${syncTone}`}
              disabled={!profile || busy}
              title={sync?.message ?? (sync?.status === 'offline' ? 'Offline – will retry on the next sync' : profile ? 'Pull the latest server config' : 'Select a profile to sync')}
              aria-label="Resync"
              onClick={() => void resync()}
            >
              <span className="resync-icon">↻</span>
            </button>
          </div>
        </label>

        <div className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="spacer" />
        <button className="quit" title="Close StarDöring" onClick={() => void api.app.quit()}>
          Exit
        </button>
        <ActivityLog compact notify={setToast} onMaximize={() => void api.activity.openWindow().catch((e) => setToast(errorText(e)))} />
        <div className="version">v{version}</div>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar (double-click to reset)"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onPointerMove={onResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetSidebar}
        />
      </nav>

      {/* Keyed by profile: switching in the sidebar reloads every page against the new one. */}
      <main className="content" key={activeId ?? 'local'}>
        {tab === 'dashboard' && <Dashboard {...pageProps} />}
        {tab === 'mods' && <Mods {...pageProps} />}
        {tab === 'add' && <AddMod {...pageProps} />}
        {tab === 'config' && <ModConfig {...pageProps} />}
        {tab === 'saves' && <Saves notify={setToast} />}
      </main>

      {pendingSwitch && (
        <Modal title="Unpushed changes" onClose={() => setPendingSwitch(null)}>
          <p>
            “{profile?.name}” has changes that are not in its repository yet – added or removed mods, enable flags, notes or a
            rename. They stay in your Mods folder either way; switching just leaves them unpublished.
          </p>
          <div className="row">
            <Button variant="primary" busy={pushingBeforeSwitch} onClick={() => void pushThenSwitch()}>
              Push, then switch
            </Button>
            <Button
              disabled={pushingBeforeSwitch}
              onClick={() => {
                const target = pendingSwitch.id
                setPendingSwitch(null)
                void applySwitch(target)
              }}
            >
              Switch to “{pendingSwitch.name}” anyway
            </Button>
            <Button variant="ghost" disabled={pushingBeforeSwitch} onClick={() => setPendingSwitch(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}

      {deepLink && (
        <AddProfileLink
          link={deepLink}
          groups={groups.data ?? []}
          activeId={activeId}
          notify={setToast}
          reloadProfiles={reloadProfiles}
          onClose={() => setDeepLink(null)}
        />
      )}

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}

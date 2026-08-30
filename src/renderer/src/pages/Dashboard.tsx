import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import type { PageProps } from '../App'
import { ProfileManager } from '../components/settings'
import LogViewer from '../components/LogViewer'
import VersionHistory from '../components/VersionHistory'
import { Button, ErrorBox, List, Modal, Row } from '../components/ui'
import { api, errorText, gitInstallHint, useAsync, useBusy } from '../lib/hooks'
import { changeClass, stripChangeIcon } from '../lib/changes'

export default function Dashboard({ notify, profile, profiles, reloadProfiles, selectProfile, sync, config }: PageProps) {
  const force = useRef(false)
  const info = useAsync(() => api.game.getInfo(force.current))
  const mods = useAsync(() => api.mods.list())
  const gitInfo = useAsync(() => api.sync.gitInfo())
  // Latest SMAPI release, so the button can say whether there is anything to update to before it is clicked.
  const latestSmapi = useAsync(() => api.game.latestSmapi())
  // Only interesting until it is done: the row disappears once the shortcut exists.
  const steam = useAsync(() => api.steam.status())
  // AppImage only: offer to copy itself to ~/.bin, so its path stops depending on where it was downloaded.
  const appimage = useAsync(() => api.appimage.status())
  const settings = useAsync(() => api.settings.get())
  // StarDöring's own update – installed at start on its own; the row only shows what is happening.
  const update = useAsync(() => api.update.state())
  const { busy, run } = useBusy(notify)
  const [logsOpen, setLogsOpen] = useState(false)

  useEffect(() => api.game.onExit(() => void info.reload()), [])
  useEffect(() => api.update.onState((s) => update.setData(s)), [])

  // Switching profiles replaces the whole Mods folder, so every count on this page is stale the
  // moment the active profile changes. Re-read instead of waiting for the window to regain focus.
  useEffect(() => {
    void mods.reload()
    void info.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  // The pull that follows a switch installs the profile's mods a moment later – re-read when it lands.
  useEffect(() => api.serverConfig.onPull(() => void mods.reload()), [])

  // No manual refresh anywhere: the game and the mod list are re-read whenever the window is focused,
  // which covers installing a mod, moving the game or running the SMAPI installer outside the app.
  useEffect(() => {
    const onFocus = (): void => {
      void detect(true)
      void mods.reload()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const g = info.data
  const s = settings.data
  // Unknown (offline, rate-limited) leaves the button as a plain "Update" – never claim up to date on a guess.
  const smapiUpToDate = Boolean(g?.smapi.version && latestSmapi.data && !isNewerVersion(latestSmapi.data, g.smapi.version))
  const allMods = mods.data ?? null
  const u = update.data

  const openDir = (which: 'game' | 'mods' | 'saves' | 'logs') => api.game.openDir(which).catch((e) => notify(errorText(e)))

  // Re-read the game info; `fresh` skips the cache.
  const detect = async (fresh = false): Promise<void> => {
    force.current = fresh
    try {
      await info.reload()
    } finally {
      force.current = false
    }
  }

  const installSmapi = () =>
    run('smapi', async () => {
      const r = await api.game.installSmapi()
      void latestSmapi.reload()
      notify(r.message)
      await info.reload()
    })

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      settings.setData(await api.settings.set(patch))
      notify('Saved')
    } catch (e) {
      notify(errorText(e))
    }
  }

  const saveGameDir = async (dir: string | null): Promise<void> => {
    await save({ gameDirOverride: dir })
    await detect(true) // the folder changed – a cached detection would report the old install
    void mods.reload()
  }

  return (
    <>
      <h1>Dashboard</h1>

      <div className="hero">
        <div className="hero-info">
          {info.error && <ErrorBox>{info.error}</ErrorBox>}
          <List>
            <Row
              actions={
                <>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const dir = await api.app.pickFolder('Select the Stardew Valley folder').catch(() => null)
                      if (dir) await saveGameDir(dir)
                    }}
                  >
                    Set folder…
                  </Button>
                  {s?.gameDirOverride && (
                    <Button variant="ghost" onClick={() => void saveGameDir(null)}>
                      Auto-detect
                    </Button>
                  )}
                  <Button variant="ghost" disabled={!g?.found} onClick={() => void openDir('game')}>
                    Open folder
                  </Button>
                </>
              }
            >
              <span className="line">
                {!g ? (
                  info.loading ? (
                    'Looking for Stardew Valley…'
                  ) : (
                    'No game information.'
                  )
                ) : g.found ? (
                  <>
                    Found <b>Stardew Valley {g.gameVersion ?? ''}</b> {s?.gameDirOverride ? 'in the folder you picked' : <>installed via <b>{g.source}</b></>} in{' '}
                    <span className="mono">{g.gameDir}</span>
                  </>
                ) : (
                  <>
                    Could not find <b>Stardew Valley</b> – use “Set folder…” to point at it.
                  </>
                )}
              </span>
            </Row>

            <Row
              actions={
                g?.smapi.installed ? (
                  <>
                    {smapiUpToDate ? (
                      <Button variant="ghost" disabled title={`SMAPI ${latestSmapi.data} is the latest release`}>
                        Up to date
                      </Button>
                    ) : (
                      <Button variant="ghost" busy={busy === 'smapi'} onClick={() => void installSmapi()} title={latestSmapi.data ? `Install SMAPI ${latestSmapi.data}` : 'Check for a newer SMAPI and install it'}>
                        {latestSmapi.data ? `Update to ${latestSmapi.data}` : 'Update'}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setLogsOpen(true)}>
                      Logs
                    </Button>
                  </>
                ) : undefined
              }
            >
              <span className="line">
                {g &&
                  (g.smapi.installed ? (
                    <>
                      <b>SMAPI {g.smapi.version ?? ''}</b> is installed
                      {g.lastRun ? (
                        <> and last ran {g.lastRun.at ?? 'at an unknown time'} with game {g.lastRun.gameVersion ?? '?'}.</>
                      ) : (
                        <>, but has not written a log yet.</>
                      )}
                    </>
                  ) : (
                    <>
                      <b>SMAPI</b> is not installed – it is needed to play with mods.
                    </>
                  ))}
              </span>
            </Row>

            {profile && config.data && (config.data.changes.length > 0 || config.data.aheadOfServer) && (
              <Row>
                <span className="line">
                  “{profile.name}” has <b>unpushed changes</b> – Push on the Mods page publishes:
                </span>
                {config.data.changes.map((l) => (
                  <span key={l} className={changeClass(l)}>
                    {stripChangeIcon(l)}
                  </span>
                ))}
                {config.data.changes.length === 0 && <span className="sub">Local commits not on the server yet.</span>}
              </Row>
            )}

            {g?.galaxyLibs && (
              <Row>
                <span className="line">
                  {g.galaxyLibs === 'patched' ? (
                    <>
                      The game's <b>Galaxy libraries are patched</b> (executable-stack flag cleared) so co-op can reach the online services – the originals sit beside them as{' '}
                      <span className="mono">*.execstack-backup</span>.
                    </>
                  ) : (
                    <>
                      The game's <b>Galaxy libraries are not patched</b> – glibc 2.41+ refuses to load them, so co-op cannot reach the online services. The activity log says why the fix did not apply.
                    </>
                  )}
                </span>
              </Row>
            )}

            <Row
              actions={
                <Button variant="ghost" disabled={!g?.modsDir} onClick={() => void openDir('mods')}>
                  Open folder
                </Button>
              }
            >
              <span className="line">
                {mods.error ? (
                  mods.error
                ) : allMods ? (
                  <>
                    <b>
                      {allMods.filter((m) => m.enabled).length} of {allMods.length}
                    </b>{' '}
                    installed mods are enabled.
                  </>
                ) : (
                  'Counting mods…'
                )}
              </span>
            </Row>

            {u && u.phase !== 'idle' && u.phase !== 'current' && (
              <Row
                actions={
                  (u.phase === 'available' || u.phase === 'error') && (
                    <Button variant="ghost" onClick={() => void api.app.openExternal(u.releaseUrl).catch((e) => notify(errorText(e)))}>
                      Release page
                    </Button>
                  )
                }
              >
                <span className="line">
                  {u.phase === 'available' ? (
                    <>
                      StarDöring <b>{u.latestVersion}</b> is available – this is {u.currentVersion}.{u.message ? ` ${u.message}` : ''}
                    </>
                  ) : u.phase === 'error' ? (
                    <>Updating to StarDöring {u.latestVersion} failed: {u.message}</>
                  ) : (
                    u.message
                  )}
                </span>
              </Row>
            )}

            {appimage.data && (appimage.data.running || appimage.data.current) && (!appimage.data.current || !appimage.data.desktopInstalled) && (
              <Row
                actions={
                  <>
                    {!appimage.data.current && (
                      <Button
                        busy={busy === 'appimage'}
                        onClick={() =>
                          void run('appimage', async () => {
                            const r = await api.appimage.install()
                            notify(r.message)
                            await appimage.reload()
                          })
                        }
                      >
                        Install to home
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      busy={busy === 'appimage-desktop'}
                      title={`Write ${appimage.data.desktopFile} and the icons for it`}
                      onClick={() =>
                        void run('appimage-desktop', async () => {
                          const r = await api.appimage.installDesktop()
                          notify(r.message)
                          await appimage.reload() // the row goes away once both are done
                        })
                      }
                    >
                      {appimage.data.desktopInstalled ? 'Update desktop files' : 'Install desktop files'}
                    </Button>
                  </>
                }
              >
                <span className="line">
                  {!appimage.data.current ? (
                    <>
                      StarDöring is running from <b>{appimage.data.source}</b>. Installing unpacks it into{' '}
                      <b>{appimage.data.target}</b>, which keeps working when the download is moved or deleted – and is
                      the only form Steam&rsquo;s Game Mode can start
                      {appimage.data.installed ? '. This replaces the install already there' : ''}.
                    </>
                  ) : (
                    <>
                      Installed at <b>{appimage.data.target}</b>. Desktop files add it to the application menu and let{' '}
                      <b>stardoering://</b> links open it.
                    </>
                  )}
                </span>
              </Row>
            )}

            {steam.data?.steamFound && !steam.data.installed && (
              <Row
                actions={
                  <Button
                    busy={busy === 'steam'}
                    onClick={() =>
                      void run('steam', async () => {
                        const r = await api.steam.addShortcut()
                        notify(r.message)
                        await steam.reload() // on success the row goes away
                      })
                    }
                  >
                    Add to Steam
                  </Button>
                }
              >
                <span className="line">
                  StarDöring is not in your Steam library. Adding it lets you launch the modded game from Steam – Steam has to be closed for it, and shows it after its next start.
                </span>
              </Row>
            )}

            <Row>
              <span className="line">
                {gitInfo.data ? (
                  gitInfo.data.available ? (
                    <>
                      Found <b>git</b> in version <b>{gitInfo.data.version}</b>
                    </>
                  ) : (
                    <span className="hint" title={gitInstallHint()}>
                      <b>git</b> is missing
                    </span>
                  )
                ) : gitInfo.error ? (
                  gitInfo.error
                ) : (
                  'Looking for git…'
                )}
              </span>
            </Row>
          </List>
        </div>
      </div>

      <ProfileManager profile={profile} profiles={profiles} notify={notify} reloadProfiles={reloadProfiles} selectProfile={selectProfile} />

      <VersionHistory profile={profile} sync={sync} />

      {logsOpen && (
        <Modal wide title="SMAPI log" onClose={() => setLogsOpen(false)}>
          <LogViewer notify={notify} />
        </Modal>
      )}
    </>
  )
}

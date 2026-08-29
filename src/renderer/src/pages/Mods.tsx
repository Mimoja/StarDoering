import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GithubInstallProgress, GithubRelease, LibraryEntry, ModInfo, ServerConfigPullResult, ServerConfigRow, SyncProgress } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import type { PageProps } from '../App'
import { Badge, Button, Collapsible, Empty, ErrorBox, IconButton, List, Modal, Row, Section } from '../components/ui'
import { GitSettings } from '../components/settings'
import { ModConfigMenu } from '../components/ModConfigMenu'
import { api, formatDate, errorText, formatBytes, gitInstallHint, pullSummary, useAsync, useBusy } from '../lib/hooks'

// The mod list of the profile picked in the sidebar plus the pull/push that keeps it in step with its repository.
// Without a profile it falls back to the plain local mod list.
export default function Mods({ notify, profile, reloadProfiles, config }: PageProps) {
  const [gitOpen, setGitOpen] = useState(false)
  const cog = (
    <button className="cog" title="Git configuration" aria-label="Git configuration" onClick={() => setGitOpen(true)}>
      ⚙
    </button>
  )
  return (
    <>
      {profile ? (
        <ProfileMods notify={notify} profile={profile} reloadProfiles={reloadProfiles} config={config} cog={cog} />
      ) : (
        <LocalMods notify={notify} cog={cog} />
      )}
      {gitOpen && (
        <Modal title="Git configuration" onClose={() => setGitOpen(false)}>
          <GitSettings profile={profile} notify={notify} reloadProfiles={reloadProfiles} />
        </Modal>
      )}
    </>
  )
}

// With a profile: the server config (modlist.json5 + mod files in the repository)

function ProfileMods({ notify, profile, reloadProfiles, config, cog }: Pick<PageProps, 'notify' | 'reloadProfiles' | 'config'> & { profile: NonNullable<PageProps['profile']>; cog: ReactNode }) {
  // The view lives in App, loaded at start and kept across tab switches – this page only reads it and asks
  // for a background refresh. checkRemote() fetches over the network and swaps the fresher view in.
  const view = config
  // Every version this computer has downloaded, for every profile – the picker on a row reads from here.
  const lib = useAsync<LibraryEntry[]>(() => api.library.list())
  const [versionsFor, setVersionsFor] = useState<ServerConfigRow | null>(null)
  const versionsById = useMemo(() => {
    const byId = new Map<string, LibraryEntry[]>()
    for (const e of lib.data ?? []) {
      const key = e.id.toLowerCase()
      const list = byId.get(key)
      if (list) list.push(e)
      else byId.set(key, [e])
    }
    return byId
  }, [lib.data])
  const versionsOf = (r: ServerConfigRow): LibraryEntry[] => versionsById.get(r.id.toLowerCase()) ?? []
  const checkRemote = config.check
  const { busy, run } = useBusy(notify)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  // Results of the manual GitHub checks, per mod id – one API call each, so they are kept for the session.
  const [githubChecks, setGithubChecks] = useState<Record<string, GithubRelease>>({})
  const [lastPull, setLastPull] = useState<ServerConfigPullResult | null>(null)

  // Pull is not a read – it installs and rewrites mod folders – so re-fetch the view on focus, read-only, the way
  // the Dashboard and Saves reload themselves.
  const checkRef = useRef(checkRemote)
  checkRef.current = checkRemote
  useEffect(() => {
    const onFocus = (): void => void checkRef.current()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Pulls nobody clicked here – after a profile switch, at start, before Play – also land in the panel
  // below. App toasts those, but a toast is six seconds; errors have to still be readable afterwards.
  useEffect(
    () => api.serverConfig.onPull((e) => (e.groupId === profile.id ? setLastPull(e) : undefined)),
    [profile.id]
  )

  // 'done' and 'error' both end an operation, so either one clears the line. The error is not toasted here: Pull and
  // Push emit it *and* throw (run() reports those), and the background fetch fails quietly offline – see the sync state.
  useEffect(() => api.sync.onProgress((p) => setProgress(p.phase === 'done' || p.phase === 'error' ? null : p)), [])
  const [download, setDownload] = useState<GithubInstallProgress | null>(null)
  useEffect(() => api.github.onProgress((p) => setDownload(p.phase === 'done' || p.phase === 'error' ? null : p)), [])

  const v = view.data
  // A rename only exists in the local draft until the next push, so re-read the view WITHOUT a
  // fetch: view({ fetch: true }) would re-adopt the name still sitting in the repository.
  const afterRename = async (): Promise<void> => {
    view.setData(await api.serverConfig.view({ fetch: false }))
    await reloadProfiles()
  }

  const refresh = async (): Promise<void> => {
    await checkRemote()
    await reloadProfiles() // view() adopts the repository's name into the group
  }

  const pull = () =>
    run('pull', async () => {
      const r = await api.serverConfig.pull()
      setLastPull(r)
      notify(pullSummary(r))
      // A mod folder dropped into Mods/ by hand reaches the library here.
      await api.library.capture().catch(() => [])
      await lib.reload()
      await refresh()
    })

  const push = () =>
    run('push', async () => {
      const r = v?.hasModlist ? await api.serverConfig.push() : await api.serverConfig.create()
      notify(r.message)
      await refresh()
    })

  const setEnabled = (row: ServerConfigRow, enabled: boolean) =>
    run(`toggle-${row.id}`, async () => {
      await api.serverConfig.setEnabled(row.id, enabled)
      await view.reload()
    })

  // Nothing downloads by itself: open the mod's page, then ask for the zip right away.
  // GitHub-hosted mods are fetched and installed in-app (no credentials needed) with live progress; anything
  // else goes the browser → "Install from zip" way.
  const installFromPage = (row: ServerConfigRow) =>
    run(`install-${row.id}`, async () => {
      if (row.github) {
        const r = await api.github.install({ id: row.id, name: row.name, repo: row.github })
        notify(r.message)
        if (r.phase === 'done') await view.reload()
        return
      }
      if (row.pageUrl) await api.app.openExternal(row.pageUrl)
      const r = await api.mods.install()
      if (r.installed.length || r.errors.length) notify([...r.installed.map((n) => `Installed ${n}`), ...r.errors].join('\n'))
      if (r.installed.length) await view.reload()
    })

  // Pull keeps unpushed draft edits and re-applies them on top of the server config, so it is safe to
  // press with work in progress. Revert is the one operation that throws the draft away.
  const revert = () =>
    run('revert', async () => {
      if (!confirm('Discard your unpushed changes and restore the server config?\n\nEnabled/disabled states, notes, the farm name and mods added here but never pushed are lost. Downloaded mods stay.')) return
      const r = await api.serverConfig.revert()
      setLastPull(r)
      notify(pullSummary(r))
      await refresh()
    })

  // The catalog only knows mods published on a mod site; a GitHub-only mod has to be looked up on demand,
  // and one lookup is one call against GitHub's 60/hour, so it never happens for the whole list at once.
  const checkGithub = (row: ServerConfigRow) =>
    run(`github-${row.id}`, async () => {
      const release = await api.github.latestRelease(row.github as string)
      setGithubChecks((prev) => ({ ...prev, [row.id]: release }))
      const newer = row.installedVersion ? isNewerVersion(release.version, row.installedVersion) : false
      notify(
        newer
          ? `${row.name}: ${release.version} is on GitHub, ${row.installedVersion} is installed.`
          : `${row.name}: GitHub is at ${release.version}${row.installedVersion ? ' – same as installed' : ''}.`
      )
    })

  // Downloaded mods join the config one at a time, only when asked – a push does not sweep them in.
  const addToConfig = (row: ServerConfigRow) =>
    run(`add-${row.id}`, async () => {
      await api.serverConfig.addInstalled([row.id])
      notify(`“${row.name}” added to the server config – push to publish it.`)
      await view.reload()
    })

  // Remove only takes the mod out of the config – the files stay and it reappears under Downloaded, where
  // "Add to config" puts it back. Nothing is destroyed, so it asks nothing; the push is the deliberate step.
  const remove = (row: ServerConfigRow) =>
    run(`remove-${row.id}`, async () => {
      await api.serverConfig.removeFromConfig(row.id)
      notify(`“${row.name}” moved to Downloaded – it stays on this computer. Push to publish the change.`)
      await view.reload()
    })

  // Deleting the files is the destructive one, and it lives with the downloaded mods.
  const deleteFiles = (row: ServerConfigRow) =>
    run(`delete-${row.id}`, async () => {
      if (!row.folder) return
      if (!confirm(`Move “${row.name}” to the trash?\n\nIts files leave your Mods folder. It is not in this server config, so nobody else is affected.`)) return
      await api.mods.remove(row.folder)
      notify(`“${row.name}” moved to the trash.`)
      await view.reload()
    })

  // SMAPI's built-ins belong with the installed mods, not with the downloaded ones: they are not a choice
  // anybody made in this config and they cannot be added to it.
  const inConfig = (v?.rows ?? []).filter((r) => r.inConfig || r.bundled)
  const extra = (v?.rows ?? []).filter((r) => r.state === 'extra' && !r.bundled)

  return (
    <>
      <h1>Mods</h1>

      {view.error && <ErrorBox>{view.error}</ErrorBox>}
      {v && !v.gitAvailable && <ErrorBox>{gitInstallHint()}</ErrorBox>}
      {v?.modlistErrors.map((e) => <ErrorBox key={e}>{e}</ErrorBox>)}
      {v?.warnings.map((w) => (
        <p className="hint" key={w}>
          {w}
        </p>
      ))}
      {download && (
        <p className="progress">
          {download.phase} · {download.message}
          {download.phase === 'downloading' && download.total ? ` (${Math.round((download.received / download.total) * 100)}%)` : ''}
        </p>
      )}
      {progress && (
        <p className="progress">
          {progress.phase}
          {progress.message ? ` · ${progress.message}` : ''}
        </p>
      )}

      {lastPull && lastPull.errors.length > 0 && (
        <Section
          title={`Last pull · ${lastPull.errors.length} error${lastPull.errors.length === 1 ? '' : 's'}`}
          actions={
            <Button variant="ghost" onClick={() => setLastPull(null)}>
              Dismiss
            </Button>
          }
        >
          <List>
            {lastPull.errors.map((e) => (
              <Row key={e}>
                <span className="line bad">{e}</span>
              </Row>
            ))}
          </List>
        </Section>
      )}

      <Section
        title={<FarmName profile={profile} count={v ? inConfig.length : null} notify={notify} onRenamed={afterRename} />}
        actions={
          <>
            <Button busy={busy === 'pull'} disabled={!v?.gitAvailable} onClick={() => void pull()}>
              Pull
            </Button>
            <Button variant={v?.unpushed ? 'primary' : 'default'} busy={busy === 'push'} disabled={!v?.gitAvailable} onClick={() => void push()}>
              {v && !v.hasModlist ? 'Create server config' : 'Push'}
            </Button>
            {/* Revert is dimmed while there is nothing to throw away. */}
            <Button
              variant="ghost"
              busy={busy === 'revert'}
              disabled={!v?.gitAvailable || !v?.unpushed}
              onClick={() => void revert()}
              title={v?.unpushed ? 'Throw away the unpublished changes here and take the server config as it stands' : 'Nothing unpublished to throw away'}
            >
              Revert
            </Button>
            {cog}
          </>
        }
      >
        <List>
          <Row label="Repository">
            <span className="sub mono">
              {profile.remote.url} · {profile.remote.branch}
            </span>
            {v?.aheadOfServer && <Badge tone="info" title="This branch exists only on this computer so far – Push publishes it">not on the server yet</Badge>}
            {v?.unpushed && <Badge tone="warn">unpushed changes</Badge>}
            {v?.draft && (
              <Button
                variant="ghost"
                busy={busy === 'discard'}
                onClick={() =>
                  void run('discard', async () => {
                    await api.serverConfig.discardDraft()
                    await view.reload()
                  })
                }
              >
                Discard draft
              </Button>
            )}
          </Row>
          {v?.smapi && (
            <Row label="SMAPI">
              <Badge tone={v.smapi.ok ? 'ok' : 'warn'}>{v.smapi.installed ?? 'not installed'}</Badge>
              <span className="sub">{v.smapi.message}</span>
            </Row>
          )}
        </List>

        {view.loading && !v && <Empty>Fetching the server config…</Empty>}

        {/* Always rendered, empty included: an empty config is a state worth seeing, not a missing section. */}
        <div className="subhead">Installed ({inConfig.length})</div>
        <List>
          {inConfig.map((r) => (
            <ModRow key={r.id} row={r} busy={busy} versions={versionsOf(r).length} onVersions={setVersionsFor} onToggle={setEnabled} onInstall={installFromPage} onRemove={remove} onCheckGithub={checkGithub} github={githubChecks[r.id] ?? null} onReload={() => view.reload()} notify={notify} />
          ))}
        </List>
      </Section>

      {/* Mods that happen to be installed here are not part of this server config – they are not selected,
          not counted, and a push leaves them alone. Folded away so the config itself is what the page shows. */}
      {extra.length > 0 && (
        <Collapsible title={`Downloaded (${extra.length})`}>
          <List>
            {extra.map((r) => (
              <ModRow key={r.id} row={r} busy={busy} configured={false} versions={versionsOf(r).length} onVersions={setVersionsFor} onToggle={setEnabled} onInstall={installFromPage} onAdd={addToConfig} onRemove={remove} onDelete={deleteFiles} onCheckGithub={checkGithub} github={githubChecks[r.id] ?? null} onReload={() => view.reload()} notify={notify} />
            ))}
          </List>
        </Collapsible>
      )}

      {versionsFor && (
        <VersionPicker
          row={versionsFor}
          versions={versionsOf(versionsFor)}
          onClose={() => setVersionsFor(null)}
          onChanged={async () => {
            await Promise.all([lib.reload(), view.reload()])
          }}
          notify={notify}
        />
      )}
    </>
  )
}

// The versions of one mod this computer has downloaded. A profile runs exactly one – picking another copies it over
// the installed one, keeping folder name and enabled state. The library is shared by every profile.
function VersionPicker({
  row,
  versions,
  onClose,
  onChanged,
  notify
}: {
  row: ServerConfigRow
  versions: LibraryEntry[]
  onClose: () => void
  onChanged: () => Promise<void>
  notify: (m: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      notify(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title={`${row.name} · downloaded versions`} onClose={onClose}>
      <p className="sub">
        This computer keeps every version it has downloaded. The profile uses one at a time – the others stay here for
        other profiles, or for going back.
      </p>
      <List>
        {versions.map((v) => {
          const current = row.installedVersion === v.version
          return (
            <Row
              key={v.version}
              label={v.version}
              actions={
                <>
                  {!current && (
                    <Button
                      busy={busy === `use-${v.version}`}
                      onClick={() =>
                        void act(`use-${v.version}`, async () => {
                          await api.library.install(row.id, v.version)
                          notify(`${row.name} ${v.version} installed.`)
                        })
                      }
                    >
                      Use
                    </Button>
                  )}
                  <Button
                    busy={busy === `del-${v.version}`}
                    onClick={() =>
                      void act(`del-${v.version}`, async () => {
                        if (!confirm(`Delete the stored copy of ${row.name} ${v.version}? The installed files stay as they are.`)) return
                        await api.library.remove(row.id, v.version)
                      })
                    }
                  >
                    Delete
                  </Button>
                </>
              }
            >
              {current && <Badge tone="ok">in use here</Badge>}
              <span className="sub">{formatBytes(v.sizeBytes)}</span>
              <span className="sub">downloaded {formatDate(v.addedAt)}</span>
            </Row>
          )
        })}
      </List>
    </Modal>
  )
}

// One badge for where a mod's files stand: installed from repo · installed locally · in repo · null
// when nobody has the files. The `state` badge only adds what this does not say (see showState).
function originBadge(row: ServerConfigRow): { label: string; tone: 'ok' | 'info'; title: string } | null {
  if (row.installed)
    return row.inRepo
      ? { label: 'installed from repo', tone: 'ok', title: 'the files are in the repository – Pull keeps them in step' }
      : { label: 'installed locally', tone: 'info', title: 'installed on this computer only – Push publishes the files to the repository' }
  return row.inRepo ? { label: 'in repo', tone: 'info', title: 'the repository has the files – Pull installs it' } : null
}

function ModRow({
  row,
  busy,
  configured = true,
  versions = 0,
  onVersions,
  onAdd,
  onDelete,
  onToggle,
  onInstall,
  onRemove,
  onCheckGithub,
  github,
  onReload,
  notify
}: {
  row: ServerConfigRow
  busy: string | null
  // False for mods that are only installed locally: no enable flag, no note – neither belongs to them.
  configured?: boolean
  // How many versions of this mod the local library holds.
  versions?: number
  // Opens the version picker for this row.
  onVersions?: (r: ServerConfigRow) => void
  // Given for unlisted mods: puts this one into the config draft.
  onAdd?: (r: ServerConfigRow) => Promise<void>
  // Given for unlisted mods: moves the mod's files to the trash.
  onDelete?: (r: ServerConfigRow) => Promise<void>
  onToggle: (r: ServerConfigRow, enabled: boolean) => Promise<void>
  onInstall: (r: ServerConfigRow) => Promise<void>
  onRemove: (r: ServerConfigRow) => Promise<void>
  onCheckGithub: (r: ServerConfigRow) => Promise<void>
  // Result of a manual GitHub check for this row, once the user has asked for one.
  github: GithubRelease | null
  onReload: () => Promise<void>
  notify: (m: string) => void
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const checked = row.localEnabled ?? row.configEnabled ?? true
  // Ships with SMAPI: listed for completeness, but nothing here is the user's to change.
  const builtIn = row.bundled
  const origin = originBadge(row)
  const stateTone = row.state === 'missing' ? 'warn' : row.state === 'outdated' ? 'info' : 'neutral'
  // "installed" and "extra" are already covered by the origin badge; the rest still adds something.
  const showState = row.state !== 'installed' && row.state !== 'extra'
  // What a Pull would do here: not installed + in repo → installs it; installed + repo copy newer → updates it;
  // repo copy matches → nothing, though a newer version may exist on the mod page.
  const pullInstalls = row.inRepo && !row.installed
  const pullUpdates = row.inRepo && row.installed && isNewerVersion(row.repoVersion, row.installedVersion)
  const pageNewer = !pullUpdates && isNewerVersion(row.latestVersion, row.installedVersion)
  // Installing by hand (page → zip) is the only route when the repository has no copy.
  const needsFiles = !row.inRepo && (!row.installed || pageNewer)

  // SMAPI's own mods are shown for completeness only: no flag, no note, no config membership to change.
  // Rendered separately so the growing action list below can never sprout a button that acts on them.
  if (builtIn)
    return (
      <div className="mod">
        <span />
        <div className="mod-name">
          <span className="name">{row.name}</span>
          {row.description && <span className="mod-desc" title={row.description}>{row.description}</span>}
          <span className="sub">ships with SMAPI</span>
        </div>
        <div className="mod-meta">
          <span className={row.installedVersion ? '' : 'sub'}>{row.installedVersion ?? '–'}</span>
          <span className="sub mono" title={row.id}>
            {row.id}
          </span>
        </div>
        <div className="mod-badges">
          <Badge title="Installed and updated with SMAPI itself">built-in</Badge>
        </div>
        <div className="mod-actions">
          {row.folder && <IconButton name="folder" label="Open the mod folder" onClick={() => api.mods.open(row.folder as string).catch((e) => notify(errorText(e)))} />}
        </div>
      </div>
    )

  return (
    <div className={`mod${configured && !checked ? ' muted' : ''}`}>
      {configured ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={busy === `toggle-${row.id}`}
          onChange={(e) => void onToggle(row, e.target.checked)}
          title={checked ? 'Disable' : 'Enable'}
        />
      ) : (
        <span />
      )}

      <div className="mod-name">
        <span className="name">{row.name}</span>
        {row.description && (
          <span className="mod-desc" title={row.description}>
            {row.description}
          </span>
        )}
        {configured ? <NoteInput row={row} onSaved={onReload} notify={notify} /> : <span className="sub">not in the config</span>}
      </div>

      {/* Two fixed lines – version above ID – so the column reads the same down the whole list. */}
      <div className="mod-meta">
        {/* The library keeps every version this computer has downloaded – the version line opens the picker. */}
        {versions > 0 && onVersions ? (
          <button className="version-pick" title={`${versions} version${versions === 1 ? '' : 's'} downloaded – pick one`} onClick={() => onVersions(row)}>
            {row.installedVersion ? `${row.installedVersion}${pullUpdates ? ` → ${row.repoVersion}` : ''}` : (row.repoVersion ?? '–')} ▾
          </button>
        ) : (
          <span className={row.installedVersion ? '' : 'sub'}>
            {row.installedVersion ? `${row.installedVersion}${pullUpdates ? ` → ${row.repoVersion}` : ''}` : (row.repoVersion ?? '–')}
          </span>
        )}
        <span className="sub mono" title={row.id}>
          {row.id}
        </span>
      </div>

      <div className="mod-badges">
        {origin && (
          <Badge tone={origin.tone} title={origin.title}>
            {origin.label}
          </Badge>
        )}
        {showState && <Badge tone={stateTone}>{row.state}</Badge>}
        {pullInstalls && <span className="sub">pull to install</span>}
        {pullUpdates && <span className="sub">pull to update ({row.repoVersion})</span>}
        {pageNewer && <span className="sub">newer version on the mod page ({row.latestVersion})</span>}
        {github && (
          <span className="sub" title={`${github.repo} · ${github.source === 'tag' ? 'newest tag' : 'latest release'}${github.publishedAt ? ` · ${new Date(github.publishedAt).toLocaleDateString()}` : ''}`}>
            GitHub {github.version}
            {row.installedVersion && isNewerVersion(github.version, row.installedVersion) ? ' – newer than installed' : ''}
          </span>
        )}
        {row.errors.map((e) => (
          <span className="hint" key={e}>
            {e}
          </span>
        ))}
      </div>

      <div className="mod-actions">
        {onAdd && (
          <Button variant="primary" busy={busy === `add-${row.id}`} title="Put this mod into the server config (published on the next push)" onClick={() => void onAdd(row)}>
            Add to config
          </Button>
        )}
        {!row.inRepo && needsFiles && row.pageUrl && (
          <Button busy={busy === `install-${row.id}`} title="Opens the mod page, then asks for the downloaded zip" onClick={() => void onInstall(row)}>
            Install
          </Button>
        )}
        {row.pageUrl && (
          <IconButton name="website" label="Open the mod page in the browser" onClick={() => api.app.openExternal(row.pageUrl as string).catch((e) => notify(errorText(e)))} />
        )}
        {row.github && !row.latestVersion && (
          <IconButton
            name="github"
            label={`Ask github.com/${row.github} for its latest release or tag`}
            busy={busy === `github-${row.id}`}
            onClick={() => void onCheckGithub(row)}
          />
        )}
        {row.folder && <IconButton name="settings" label="Change this mod's own settings (its config.json)" onClick={() => setConfigOpen(true)} />}
        {row.folder && <IconButton name="folder" label="Open the mod folder" onClick={() => api.mods.open(row.folder as string).catch((e) => notify(errorText(e)))} />}
        {configured ? (
          <IconButton name="remove" label="Take it out of the server config – the files stay under Downloaded" busy={busy === `remove-${row.id}`} onClick={() => void onRemove(row)} />
        ) : (
          onDelete &&
          row.folder && (
            <Button busy={busy === `delete-${row.id}`} title="Move the mod's files to the trash" onClick={() => void onDelete(row)}>
              Delete
            </Button>
          )
        )}
      </div>

      {configOpen && row.folder && <ModConfigMenu folder={row.folder} modName={row.name} notify={notify} onSaved={onReload} onClose={() => setConfigOpen(false)} />}
    </div>
  )
}

// The farm name, editable in place. It lives in modlist.json5, so the new name goes into the config draft and is
// published on the next push; a pull keeps it, only Revert throws it away – like notes and enabled flags.
function FarmName({ profile, count, notify, onRenamed }: { profile: NonNullable<PageProps['profile']>; count: number | null; notify: (m: string) => void; onRenamed: () => Promise<void> }) {
  const [draft, setDraft] = useState(profile.name)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(profile.name), [profile.name])

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    if (saving || next === profile.name) return
    if (!next) {
      setDraft(profile.name)
      return
    }
    setSaving(true)
    try {
      await api.serverConfig.setName(next)
      await onRenamed()
    } catch (e) {
      notify(errorText(e))
      setDraft(profile.name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="row">
      <input
        className="note"
        style={{ width: 'auto', minWidth: 140 }}
        value={draft}
        disabled={saving}
        spellCheck={false}
        title="Rename this farm – published with the next push. Pulling keeps it; only Revert discards it."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') setDraft(profile.name)
        }}
      />
      {count != null && <span>· {count} mods</span>}
    </span>
  )
}

// The user's own free-text note for a mod; saved on blur or Enter and published with the next push.
function NoteInput({ row, onSaved, notify }: { row: ServerConfigRow; onSaved: () => Promise<void>; notify: (m: string) => void }) {
  const [draft, setDraft] = useState(row.note ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(row.note ?? ''), [row.note])

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    if (saving || next === (row.note ?? '')) return
    setSaving(true)
    try {
      await api.serverConfig.setNote(row.id, next)
      await onSaved()
    } catch (e) {
      notify(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <input
      className="note"
      value={draft}
      placeholder="add a note…"
      spellCheck={false}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') setDraft(row.note ?? '')
      }}
    />
  )
}

// Without a profile: the plain local mod list

function LocalMods({ notify, cog }: { notify: (m: string) => void; cog: ReactNode }) {
  const mods = useAsync(() => api.mods.list())
  // A mod folder dropped into Mods/ by hand is picked up whenever the window regains focus.
  useEffect(() => {
    const onFocus = (): void => void mods.reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Every version this computer has ever downloaded – how a mod comes back after a profile switch
  // moved it out, or after it was removed. Available with or without a profile.
  const lib = useAsync<LibraryEntry[]>(() => api.library.list())
  const { busy, run } = useBusy(notify)
  const [filter, setFilter] = useState('')
  // Mod folder whose settings dialog is open, if any.
  const [configFolder, setConfigFolder] = useState<string | null>(null)

  // Newest stored version per mod, minus whatever is already installed.
  const restorable = useMemo(() => {
    const installed = new Set((mods.data ?? []).map((m) => m.uniqueId.toLowerCase()).filter(Boolean))
    const newest = new Map<string, LibraryEntry>()
    for (const e of lib.data ?? []) {
      const key = e.id.toLowerCase()
      if (installed.has(key)) continue
      const have = newest.get(key)
      if (!have || e.addedAt > have.addedAt) newest.set(key, e)
    }
    return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [lib.data, mods.data])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (mods.data ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || m.uniqueId.toLowerCase().includes(q) || m.author.toLowerCase().includes(q))
  }, [mods.data, filter])

  const toggle = (m: ModInfo) =>
    run(m.folder, async () => {
      await api.mods.setEnabled(m.folder, !m.enabled)
      await mods.reload()
    })

  return (
    <>
      <h1>Mods</h1>
      <p className="sub">No profile selected – these are the mods installed on this computer. Pick a profile in the sidebar to sync them with a repository.</p>

      <Section
        title={mods.data ? `${mods.data.length} mods` : 'Mods'}
        actions={
          <>
            <input className="grow" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <Button
              busy={busy === 'install'}
              onClick={() =>
                void run('install', async () => {
                  const r = await api.mods.install()
                  if (r.installed.length || r.errors.length) notify([...r.installed.map((s) => `Installed ${s}`), ...r.errors].join('\n'))
                  await mods.reload()
                })
              }
            >
              + Install from zip
            </Button>
            <Button variant="ghost" onClick={() => api.game.openDir('mods').catch((e) => notify(errorText(e)))}>
              Open folder
            </Button>
            {cog}
          </>
        }
      >
        {mods.error && <ErrorBox>{mods.error}</ErrorBox>}
        {mods.data && mods.data.length === 0 && <Empty>No mods found. Install SMAPI, then drop mod folders into Mods/ or use “Install from zip”.</Empty>}
        {visible.length > 0 && (
          <div className="list">
            {visible.map((m) => (
              <div className={`mod${m.enabled ? '' : ' muted'}`} key={m.folder}>
                <input
                  type="checkbox"
                  checked={m.enabled}
                  disabled={busy === m.folder}
                  onChange={() => void toggle(m)}
                  title={m.enabled ? 'Disable' : 'Enable'}
                />
                <div className="mod-name">
                  <span className="name">{m.name}</span>
                  {m.author && <span className="sub">by {m.author}</span>}
                </div>
                <div className="mod-meta">
                  <span>
                    {m.version} <span className="sub">· {formatBytes(m.sizeBytes)}</span>
                  </span>
                  <span className="sub mono" title={m.uniqueId || m.folder}>
                    {m.uniqueId || m.folder}
                  </span>
                </div>
                <div className="mod-badges">
                  {m.kind === 'content-pack' && <Badge tone="info">content pack</Badge>}
                  {m.manifestErrors.map((e) => (
                    <span className="hint" key={e}>
                      {e}
                    </span>
                  ))}
                  {m.missingDependencies.length > 0 && <span className="hint">missing: {m.missingDependencies.join(', ')}</span>}
                </div>
                <div className="mod-actions">
                  <Button title="Change this mod's own settings (its config.json)" onClick={() => setConfigFolder(m.folder)}>
                    Settings
                  </Button>
                  <Button title="Open the mod folder" onClick={() => api.mods.open(m.folder).catch((e) => notify(errorText(e)))}>
                    Folder
                  </Button>
                  <Button
                    onClick={() =>
                      void run(`rm-${m.folder}`, async () => {
                        if (!confirm(`Move "${m.name}" to the trash?`)) return
                        await api.mods.remove(m.folder)
                        await mods.reload()
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={restorable.length > 0 ? `${restorable.length} in the library, not installed` : 'Mod library'}>
        {lib.error && <ErrorBox>{lib.error}</ErrorBox>}
        {lib.data && lib.data.length === 0 && <Empty>The library is empty. Mods are added to it as they are installed.</Empty>}
        {lib.data && lib.data.length > 0 && restorable.length === 0 && <Empty>Everything in the library is installed.</Empty>}
        {restorable.length > 0 && (
          <div className="list">
            {restorable.map((e) => (
              <div className="mod" key={`${e.id}@${e.version}`}>
                {/* .mod is a five-column grid: the empty cells keep this row aligned with the
                    installed ones above, which have a checkbox first and badges before the actions. */}
                <span />
                <div className="mod-name">
                  <span className="name">{e.name}</span>
                </div>
                <div className="mod-meta">
                  <span>
                    {e.version} <span className="sub">· {formatBytes(e.sizeBytes)}</span>
                  </span>
                  <span className="sub mono" title={e.id}>
                    {e.id}
                  </span>
                </div>
                <div className="mod-badges" />
                <div className="mod-actions">
                  <Button
                    busy={busy === `lib-${e.id}`}
                    title={`Install ${e.name} ${e.version} from the library`}
                    onClick={() =>
                      void run(`lib-${e.id}`, async () => {
                        await api.library.install(e.id, e.version)
                        notify(`Installed ${e.name} ${e.version}`)
                        await mods.reload()
                      })
                    }
                  >
                    Install
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {configFolder && (
        <ModConfigMenu
          folder={configFolder}
          modName={(mods.data ?? []).find((m) => m.folder === configFolder)?.name}
          notify={notify}
          onSaved={() => mods.reload()}
          onClose={() => setConfigFolder(null)}
        />
      )}
    </>
  )
}

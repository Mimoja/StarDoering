import { useEffect, useMemo, useState } from 'react'
import type { ModInfo, ServerConfigRow } from '@shared/types'
import type { PageProps } from '../App'
import { Badge, Button, Empty, ErrorBox, Section } from '../components/ui'
import { ModConfigPanel } from '../components/ModConfigMenu'
import { api, errorText, pullSummary, useAsync, useBusy } from '../lib/hooks'

// Every mod with a config.json, one row each, unfolded to show its settings – the launcher's answer to the in-game GMCM.
// config.json travels with the mod folder in the repository, so each row also says where its settings stand against the profile.
export default function ModConfig({ notify, profile, config }: PageProps) {
  const mods = useAsync(() => api.mods.list())
  const { busy, run } = useBusy(notify)
  const [filter, setFilter] = useState('')
  // Folders whose settings are unfolded – several can be open at once.
  const [open, setOpen] = useState<string[]>([])
  // Bumped when the game (or a hand edit) rewrote a folder's config.json: remounts that entry with the values on disk.
  const [touched, setTouched] = useState<Record<string, number>>({})
  useEffect(
    () =>
      api.mods.onChange((e) => {
        setTouched((t) => ({ ...t, ...Object.fromEntries(e.configs.map((f) => [f, (t[f] ?? 0) + 1])) }))
        void mods.reload()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // A saved config.json is a change to the profile's repository, so the server config view has to be
  // re-read as well: it carries the "config ↑" badges and whether a push has anything to publish.
  const afterSave = async (): Promise<void> => {
    await mods.reload()
    await config.reload()
  }

  // The profile's row per mod – by UniqueID, falling back to the folder for a mod without a manifest ID.
  const rowFor = useMemo(() => {
    const byId = new Map<string, ServerConfigRow>()
    const byFolder = new Map<string, ServerConfigRow>()
    for (const r of config.data?.rows ?? []) {
      byId.set(r.id.toLowerCase(), r)
      if (r.folder) byFolder.set(r.folder, r)
    }
    return (m: ModInfo): ServerConfigRow | null => (m.uniqueId ? byId.get(m.uniqueId.toLowerCase()) : undefined) ?? byFolder.get(m.folder) ?? null
  }, [config.data])

  const configurable = useMemo(() => (mods.data ?? []).filter((m) => m.hasConfig), [mods.data])
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return configurable.filter((m) => !q || m.name.toLowerCase().includes(q) || m.uniqueId.toLowerCase().includes(q) || m.author.toLowerCase().includes(q))
  }, [configurable, filter])

  const unpushed = profile ? configurable.filter((m) => rowFor(m)?.configState === 'unpushed') : []
  const toggle = (folder: string): void => setOpen((prev) => (prev.includes(folder) ? prev.filter((f) => f !== folder) : [...prev, folder]))

  const push = () =>
    run('push', async () => {
      const r = await api.serverConfig.push()
      notify(r.message)
      await config.check()
      await mods.reload()
    })

  const pull = () =>
    run('pull', async () => {
      const r = await api.serverConfig.pull()
      notify(pullSummary(r))
      await config.check()
      await mods.reload()
    })

  // Revert reads the clone already on disk, so it is instant and works offline – Pull is the one that
  // goes and asks the server. `ids` empty means "every mod whose settings differ".
  const revert = (ids?: string[], what?: string) =>
    run(ids ? `revert-${ids[0]}` : 'revert', async () => {
      if (!confirm(ids ? `Throw away the local settings of ${what} and take the ones from “${profile?.name}”?` : `Throw away the local changes to ${unpushed.length} config.json and take the ones from “${profile?.name}”?`)) return
      const r = await api.serverConfig.revertConfigs(ids)
      const touched = r.reverted.length + r.cleared.length
      notify([touched ? `Took the repository's settings back for ${touched} mod${touched === 1 ? '' : 's'}.` : 'Nothing differed from the repository.', ...r.errors.map((e) => `• ${e}`)].join('\n'))
      await afterSave()
    })

  return (
    <>
      <h1>Mod config</h1>
      <p className="sub">
        The settings each mod keeps in its own config.json. SMAPI reads them when the game starts, so a running game keeps the
        values it launched with.{' '}
        {profile
          ? `They live in the mod folder, which “${profile.name}” carries in its repository – a change here is published with the next push.`
          : 'No profile is selected, so these settings stay on this computer.'}
      </p>

      <Section
        title={mods.data ? `${configurable.length} mod${configurable.length === 1 ? '' : 's'} with settings` : 'Mod config'}
        actions={
          <>
            <input className="grow" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {profile && (
              <Button
                variant={unpushed.length > 0 ? 'primary' : 'default'}
                busy={busy === 'push'}
                disabled={unpushed.length === 0 || !config.data?.hasModlist}
                title={
                  !config.data?.hasModlist
                    ? 'This repository has no server config yet – create it on the Mods page first'
                    : unpushed.length === 0
                      ? 'Every config.json here matches the repository'
                      : `Publish ${unpushed.length} changed config.json to “${profile.name}”`
                }
                onClick={() => void push()}
              >
                Push{unpushed.length > 0 ? ` (${unpushed.length})` : ''}
              </Button>
            )}
            {profile && (
              <>
                <Button
                  busy={busy === 'pull'}
                  title={`Fetch “${profile.name}” and apply the settings it carries`}
                  onClick={() => void pull()}
                >
                  Pull
                </Button>
                <Button
                  busy={busy === 'revert'}
                  disabled={unpushed.length === 0}
                  title={
                    unpushed.length === 0
                      ? 'Every config.json here matches the repository'
                      : `Throw away the local changes to ${unpushed.length} config.json and take the repository's back`
                  }
                  onClick={() => void revert()}
                >
                  Revert{unpushed.length > 0 ? ` (${unpushed.length})` : ''}
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => api.game.openDir('mods').catch((e) => notify(errorText(e)))}>
              Open folder
            </Button>
          </>
        }
      >
        {mods.error && <ErrorBox>{mods.error}</ErrorBox>}
        {mods.data && configurable.length === 0 && <Empty>None of the installed mods has a config.json – there is nothing to configure.</Empty>}
        {configurable.length > 0 && visible.length === 0 && <Empty>No mod matches “{filter}”.</Empty>}

        {visible.length > 0 && (
          <div className="list">
            {visible.map((m) => (
              <ConfigEntry
                key={`${m.folder}#${touched[m.folder] ?? 0}`}
                mod={m}
                row={rowFor(m)}
                profiled={Boolean(profile)}
                open={open.includes(m.folder)}
                onToggle={() => toggle(m.folder)}
                onRevert={m.uniqueId ? () => void revert([m.uniqueId], `“${m.name}”`) : null}
                reverting={busy === `revert-${m.uniqueId}`}
                onSaved={afterSave}
                notify={notify}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

// What the active profile makes of this mod's config.json – the same wording the Mods page uses.
const PROFILE_BADGE: Record<ServerConfigRow['configState'], { label: string; tone: 'ok' | 'warn' | 'info'; title: string } | null> = {
  none: null,
  synced: { label: 'in the repo', tone: 'ok', title: 'these settings match the ones in the repository' },
  unpushed: { label: 'not pushed', tone: 'warn', title: 'these settings differ from the repository – push to publish them' },
  'remote-only': { label: 'config ↓', tone: 'info', title: 'the repository has settings for this mod – pull to apply them' }
}

function ConfigEntry({
  mod,
  row,
  profiled,
  open,
  onToggle,
  onRevert,
  reverting,
  onSaved,
  notify
}: {
  mod: ModInfo
  // The mod's row in the active server config, when there is a profile and it knows this mod.
  row: ServerConfigRow | null
  profiled: boolean
  open: boolean
  onToggle: () => void
  // Take this mod's settings back from the repository; null without a profile or a UniqueID.
  onRevert: (() => void) | null
  reverting: boolean
  onSaved: () => void | Promise<void>
  notify: (m: string) => void
}) {
  const profileBadge = row ? PROFILE_BADGE[row.configState] : null
  const canRevert = Boolean(onRevert) && row?.inRepo === true

  return (
    <div className="mod-entry">
      {/* The whole row is the disclosure – the triangle only shows which way it goes. */}
      <div
        className={`mod cfg-entry${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? 'Hide the settings' : 'Show the settings'}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <div className="mod-name">
          <span className="name">
            <span className="disclosure" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {mod.name}
          </span>
          {mod.author && <span className="sub">by {mod.author}</span>}
        </div>

        <div className="mod-meta">
          <span>{mod.version || '–'}</span>
          <span className="sub mono" title={mod.uniqueId || mod.folder}>
            {mod.uniqueId || mod.folder}
          </span>
        </div>

        <div className="mod-badges">
          {!mod.enabled && <Badge>disabled</Badge>}
          {mod.kind === 'content-pack' && <Badge tone="info">content pack</Badge>}
          {profileBadge && (
            <Badge tone={profileBadge.tone} title={profileBadge.title}>
              {profileBadge.label}
            </Badge>
          )}
          {/* Installed here but not part of the server config: its settings are never published. */}
          {profiled && !row?.inConfig && <span className="sub">not in this server config</span>}
        </div>

        {/* Buttons act on the mod, not on the row's fold. */}
        <div className="mod-actions" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            busy={reverting}
            disabled={!canRevert}
            title={
              !profiled
                ? 'No profile selected – there is nothing to take these settings back from'
                : !canRevert
                  ? 'This mod is not in the repository, so there are no settings to go back to'
                  : `Throw away the local settings of “${mod.name}” and take the repository's`
            }
            onClick={() => onRevert?.()}
          >
            Revert
          </Button>
          <Button variant="ghost" title="Open the mod folder" onClick={() => api.mods.open(mod.folder).catch((e) => notify(errorText(e)))}>
            Folder
          </Button>
        </div>
      </div>

      {open && (
        <div className="mod-detail cfg-detail">
          <ModConfigPanel folder={mod.folder} notify={notify} onSaved={onSaved} />
        </div>
      )}
    </div>
  )
}

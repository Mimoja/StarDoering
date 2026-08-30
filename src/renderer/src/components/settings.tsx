import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, BranchInfo, GitRemoteConfig, SshKeyInfo, SyncGroup } from '@shared/types'
import { buildProfileLink } from '@shared/protocol'
import { Button, ErrorBox, List, Modal, Row, Section } from './ui'
import { api, errorText, formatDate, useAsync, useBusy } from '../lib/hooks'

const emptyRemote = (): GitRemoteConfig => ({ kind: 'git', url: '', branch: 'main', sshKeyPath: null, sshPassphrase: '', token: '' })

// Profile management on the dashboard: which server config this computer uses, plus adding and removing one. The git
// details of a profile live behind the cogwheel on the Mods page.
export function ProfileManager({ profile, profiles, notify, reloadProfiles, selectProfile }: { profile: SyncGroup | null; profiles: SyncGroup[]; notify: (m: string) => void; reloadProfiles: () => Promise<void>; selectProfile: (id: string) => Promise<void> }) {
  const keys = useAsync(() => api.app.listSshKeys())
  const localPath = useAsync(() => (profile ? api.sync.localPath(profile.id) : Promise.resolve(null)), [profile?.id])
  const branchInfo = useAsync<BranchInfo | null>(() => (profile ? api.sync.branches(profile.id) : Promise.resolve(null)), [profile?.id])
  const { busy, run } = useBusy(notify)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editingGroup = profiles.find((g) => g.id === editingId) ?? null
  // Profile whose "this branch is new" chooser was dismissed – not reopened for that one.
  const [branchDismissed, setBranchDismissed] = useState<string | null>(null)

  const select = (id: string) => run('select', () => selectProfile(id))

  const removeGroup = (group: SyncGroup) =>
    run(`remove-${group.id}`, async () => {
      if (!confirm(`Remove "${group.name}" from this device? Your mods stay; the repository is not touched.`)) return
      await api.sync.removeGroup(group.id)
      await reloadProfiles()
    })

  // What a server owner hands out instead of "clone this URL, branch that": one click in the recipient's app.
  const copyLink = (group: SyncGroup) =>
    run(`copy-${group.id}`, async () => {
      const link = buildProfileLink(group.remote)
      await api.app.copyText(link)
      notify(`Copied: ${link}`)
    })

  const openTerminal = (group: SyncGroup) =>
    run(`open-${group.id}`, async () => {
      const r = await api.sync.openTerminal(group.id)
      if (!r.ok) notify(r.error ?? 'Could not open a terminal')
    })

  const onSaved = async (group: SyncGroup, created: boolean): Promise<void> => {
    setAdding(false)
    setEditingId(null)
    if (created) await api.serverConfig.setActive(group.id)
    await reloadProfiles()
    notify(created ? 'Profile added' : 'Profile saved')
  }

  return (
    <Section
      title="Profile"
      actions={
        <Button disabled={adding} onClick={() => setAdding(true)}>
          Add profile
        </Button>
      }
    >
      <List>
        <Row
          label={
            <label className="row">
              <input type="radio" name="profile" checked={!profile} onChange={() => void select('')} />
              <span className="name">Local mods only</span>
            </label>
          }
        >
          <span className="sub">Mods are managed on this computer only.</span>
        </Row>
        {profiles.map((g) => {
          const active = g.id === profile?.id
          return (
            <Row
              key={g.id}
              label={
                <label className="row">
                  <input type="radio" name="profile" checked={active} disabled={busy === 'select'} onChange={() => void select(g.id)} />
                  <span className="name">{g.name}</span>
                </label>
              }
              actions={
                <>
                  <Button variant="ghost" disabled={editingId === g.id} title="Change the repository URL, branch or SSH key" onClick={() => setEditingId(g.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    busy={busy === `open-${g.id}`}
                    title={active ? (localPath.data ?? 'Open this profile\u2019s local clone in a terminal') : 'Open this profile\u2019s local clone in a terminal'}
                    onClick={() => void openTerminal(g)}
                  >
                    Open
                  </Button>
                  <Button variant="ghost" busy={busy === `copy-${g.id}`} title="Copy a stardoering:// link that adds this profile" onClick={() => void copyLink(g)}>
                    Link
                  </Button>
                  <Button variant="ghost" busy={busy === `remove-${g.id}`} title="Remove this profile from this computer" onClick={() => void removeGroup(g)}>
                    Remove
                  </Button>
                </>
              }
            >
              <span className="sub mono">{g.remote.url}</span>
              {active && <span className="sub">last sync {formatDate(g.lastSyncedAt)}</span>}
            </Row>
          )
        })}
        {editingGroup && <RepoEditor key={editingGroup.id} group={editingGroup} keys={keys.data ?? []} notify={notify} onSaved={onSaved} onCancel={() => setEditingId(null)} />}
        {adding && <RepoEditor key="new" group={null} keys={keys.data ?? []} notify={notify} onSaved={onSaved} onCancel={() => setAdding(false)} />}
      </List>

      {/* Opens by itself after adding or switching to a profile whose branch is not on the server. */}
      {profile && branchInfo.data && !branchInfo.data.exists && branchDismissed !== profile.id && (
        <NewBranchModal
          info={branchInfo.data}
          notify={notify}
          onCancel={() => setBranchDismissed(profile.id)}
          onCreated={async () => {
            await branchInfo.reload()
            await reloadProfiles()
          }}
        />
      )}
    </Section>
  )
}

// The profile's branch does not exist on the server yet: one dropdown picks what it starts from – an empty config or
// an existing branch – and Create pushes it straight away.
function NewBranchModal({ info, notify, onCreated, onCancel }: { info: BranchInfo; notify: (m: string) => void; onCreated: () => Promise<void>; onCancel: () => void }) {
  const [from, setFrom] = useState('')
  const { busy, run } = useBusy(notify)

  const create = () =>
    run('create', async () => {
      const r = await api.serverConfig.initBranch({ from: from || null })
      notify(r.message)
      await onCreated()
    })

  return (
    <Modal title={`Branch “${info.current}” does not exist yet`} onClose={onCancel}>
      <p className="sub">Choose what this profile's branch starts from. It is created and pushed right away.</p>
      <div className="row">
        <select className="grow" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Create empty</option>
          {info.branches.map((b) => (
            <option key={b} value={b}>
              Start from {b}
            </option>
          ))}
        </select>
        <Button variant="primary" busy={busy === 'create'} onClick={() => void create()}>
          Create
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Modal>
  )
}

// Everything git for the active profile – commit identity and repository details – behind the cogwheel on the Mods page.
export function GitSettings({ profile, notify, reloadProfiles }: { profile: SyncGroup | null; notify: (m: string) => void; reloadProfiles: () => Promise<void> }) {
  const settings = useAsync(() => api.settings.get())
  const keys = useAsync(() => api.app.listSshKeys())
  const [editing, setEditing] = useState(false)
  const s = settings.data

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      settings.setData(await api.settings.set(patch))
      notify('Saved')
    } catch (e) {
      notify(errorText(e))
    }
  }

  const onSaved = async (): Promise<void> => {
    setEditing(false)
    await reloadProfiles()
    notify('Repository saved')
  }

  return (
    <>
      <Section title="Commit identity">
        {settings.error && <ErrorBox>{settings.error}</ErrorBox>}
        {s && (
          <List>
            <TextRow label="Your name" value={s.authorName} placeholder="Git author name" hint={!s.authorName && 'Required before you can push'} onSave={(v) => save({ authorName: v.trim() })} />
            <TextRow label="E-mail" value={s.authorEmail} placeholder="you@example.com" hint={!s.authorEmail && 'Required before you can push'} onSave={(v) => save({ authorEmail: v.trim() })} />
          </List>
        )}
      </Section>

      <Section
        title="Repository"
        actions={
          profile && !editing ? (
            <Button onClick={() => setEditing(true)}>Edit</Button>
          ) : undefined
        }
      >
        <List>
          {!profile && (
            <Row label="Repository">
              <span className="sub">No profile selected – add one on the dashboard.</span>
            </Row>
          )}
          {profile && !editing && (
            <>
              <Row label="URL">
                <span className="mono">{profile.remote.url}</span>
              </Row>
              <Row label="Branch">
                <span className="mono">{profile.remote.branch}</span>
              </Row>
              <Row label="Credentials">
                <span className="sub">
                  {profile.remote.sshKeyPath ? `SSH key ${profile.remote.sshKeyPath.split('/').pop()}` : 'system default (ssh-agent / credential helper)'}
                  {profile.hasSecret ? ' · stored' : ''}
                </span>
              </Row>
            </>
          )}
          {profile && editing && <RepoEditor key={profile.id} group={profile} keys={keys.data ?? []} notify={notify} onSaved={onSaved} onCancel={() => setEditing(false)} />}
        </List>
      </Section>
    </>
  )
}

// A settings row with a text input that saves on blur / Enter, or via the Save button once changed.
function TextRow({ label, value, onSave, placeholder, hint }: { label: string; value: string; onSave: (v: string) => Promise<void>; placeholder?: string; hint?: ReactNode }) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  useEffect(() => setDraft(value), [value])
  const dirty = draft !== value

  const commit = async (): Promise<void> => {
    if (!dirty || pending.current) return
    pending.current = true
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return (
    <Row
      label={label}
      actions={
        dirty && (
          <Button variant="primary" busy={saving} onClick={() => void commit()}>
            Save
          </Button>
        )
      }
    >
      <input
        className="grow"
        type="text"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
        }}
      />
      {hint && <span className="hint">{hint}</span>}
    </Row>
  )
}

// Inline rows for adding / editing a repository: URL + Test + Add/Save, with the rest under an "Advanced" toggle.
export function RepoEditor({ group, keys, notify, onSaved, onCancel }: { group: SyncGroup | null; keys: SshKeyInfo[]; notify: (m: string) => void; onSaved: (g: SyncGroup, created: boolean) => Promise<void>; onCancel: () => void }) {
  const [remote, setRemote] = useState<GitRemoteConfig>(group ? { ...emptyRemote(), ...group.remote, sshPassphrase: '', token: '' } : emptyRemote())
  const [advanced, setAdvanced] = useState(Boolean(group))
  const { busy, run } = useBusy(notify)
  const isHttps = /^https?:/i.test(remote.url.trim())
  const patch = (p: Partial<GitRemoteConfig>) => setRemote({ ...remote, ...p })

  const payload = (): GitRemoteConfig => {
    const r: GitRemoteConfig = { ...remote, url: remote.url.trim(), branch: remote.branch.trim() || 'main', sshKeyPath: remote.sshKeyPath?.trim() || null }
    if (!r.sshKeyPath) r.sshPassphrase = ''
    if (!isHttps) r.token = ''
    if (!group) {
      // New repository: an empty secret means "none" (for edits it means "keep the stored one").
      if (!r.sshPassphrase) delete r.sshPassphrase
      if (!r.token) delete r.token
    }
    return r
  }

  const saveRepo = () =>
    run('save', async () => {
      const r = payload()
      if (!r.url) {
        notify('Enter the repository URL first')
        return
      }
      const saved = group ? await api.sync.updateGroup(group.id, { remote: r }) : await api.sync.createGroup({ remote: r })
      await onSaved(saved, !group)
    })

  return (
    <>
      <Row
        label={group ? `Edit “${group.name}”` : 'New repository'}
        actions={
          <>
            <Button variant="primary" busy={busy === 'save'} disabled={!remote.url.trim()} onClick={() => void saveRepo()}>
              {group ? 'Save' : 'Add'}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        }
      >
        <input className="grow mono" value={remote.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://github.com/you/stardew-mods.git or git@github.com:you/stardew-mods.git" spellCheck={false} autoFocus />
        {!group && <span className="sub">If the repository is empty or a new branch is selected, a new config will be created.</span>}
      </Row>
      <Row label={<button className="toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><span className="chev">{advanced ? '▾' : '▸'}</span>Advanced</button>}>
        {!advanced && (
          <span className="sub">
            branch {remote.branch || 'main'}
            {remote.sshKeyPath ? ` · key ${remote.sshKeyPath.split('/').pop()}` : ''}
            {group?.hasSecret ? ' · credentials stored' : ''}
          </span>
        )}
      </Row>
      {advanced && (
        <>
          <Row label="Branch">
            <input value={remote.branch} onChange={(e) => patch({ branch: e.target.value })} placeholder="main" spellCheck={false} />
          </Row>
          <Row
            label="SSH key"
            actions={
              <Button
                onClick={async () => {
                  const f = await api.app.pickFiles({ title: 'Select SSH private key' }).catch(() => [] as string[])
                  if (f[0]) patch({ sshKeyPath: f[0] })
                }}
              >
                Browse…
              </Button>
            }
          >
            <input className="grow mono" list="ssh-keys" value={remote.sshKeyPath ?? ''} onChange={(e) => patch({ sshKeyPath: e.target.value || null })} placeholder="system default (ssh-agent / ~/.ssh/config) – or a private key path" spellCheck={false} autoComplete="off" />
            <datalist id="ssh-keys">
              {keys.map((k) => (
                <option key={k.path} value={k.path}>
                  {k.name}
                </option>
              ))}
            </datalist>
          </Row>
          {remote.sshKeyPath && (
            <Row label="Key passphrase">
              <input className="grow" type="password" value={remote.sshPassphrase ?? ''} onChange={(e) => patch({ sshPassphrase: e.target.value })} placeholder={group?.hasSecret ? 'stored – leave empty to keep' : 'only for encrypted keys'} autoComplete="off" />
            </Row>
          )}
          {isHttps && (
            <Row label="HTTPS token">
              <input className="grow" type="password" value={remote.token ?? ''} onChange={(e) => patch({ token: e.target.value })} placeholder={group?.hasSecret ? 'stored – leave empty to keep' : 'personal access token (optional)'} autoComplete="off" />
            </Row>
          )}
        </>
      )}
    </>
  )
}

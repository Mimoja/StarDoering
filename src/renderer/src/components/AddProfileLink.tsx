import { useState } from 'react'
import type { DeepLinkAddProfile, SyncGroup } from '@shared/types'
import { Button, List, Modal, Row } from './ui'
import { api, errorText } from '../lib/hooks'

// Compare clone URLs the way a person would: scheme, credentials, .git and trailing slashes are noise.
function repoKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=\D)/, '/') // scp-style git@host:you/mods → host/you/mods
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

// A `stardoering://` link proposes a repository; this asks first. Clicking a link in a chat window must never be
// enough to make this computer clone and apply somebody's mod list.
export default function AddProfileLink({
  link,
  groups,
  activeId,
  notify,
  reloadProfiles,
  onClose
}: {
  link: DeepLinkAddProfile
  groups: SyncGroup[]
  activeId: string | null
  notify: (m: string) => void
  reloadProfiles: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const existing = groups.find((g) => repoKey(g.remote.url) === repoKey(link.url) && (g.remote.branch || 'main') === link.branch) ?? null

  const add = async (): Promise<void> => {
    setBusy('add')
    try {
      const group = await api.sync.createGroup({ name: link.name ?? undefined, remote: { kind: 'git', url: link.url, branch: link.branch } })
      await api.serverConfig.setActive(group.id)
      await reloadProfiles()
      notify(`Profile “${group.name}” added – pulling its mod list…`)
      onClose()
    } catch (e) {
      notify(errorText(e))
      setBusy(null)
    }
  }

  const switchTo = async (id: string): Promise<void> => {
    setBusy('switch')
    try {
      await api.serverConfig.setActive(id)
      await reloadProfiles()
      onClose()
    } catch (e) {
      notify(errorText(e))
      setBusy(null)
    }
  }

  if (existing) {
    return (
      <Modal title="This profile is already here" onClose={onClose}>
        <p>
          The link points at “{existing.name}”, which this computer already has.
          {existing.id === activeId ? ' It is the active profile.' : ''}
        </p>
        <List>
          <Row label="Repository">
            <span className="sub mono">{existing.remote.url}</span>
          </Row>
          <Row label="Branch">
            <span className="sub mono">{existing.remote.branch || 'main'}</span>
          </Row>
        </List>
        <div className="row">
          {existing.id !== activeId && (
            <Button variant="primary" busy={busy === 'switch'} onClick={() => void switchTo(existing.id)}>
              Switch to it
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Add this profile?" onClose={onClose}>
      <p>
        A link asked StarDöring to add a server profile. Its mod list will be pulled and the mods it names installed into your
        Mods folder – only add repositories from people you trust.
      </p>
      <List>
        <Row label="Repository">
          <span className="sub mono">{link.url}</span>
        </Row>
        <Row label="Branch">
          <span className="sub mono">{link.branch}</span>
        </Row>
        {link.name && (
          <Row label="Name">
            <span className="sub">{link.name}</span>
          </Row>
        )}
      </List>
      <div className="row">
        <Button variant="primary" busy={busy === 'add'} onClick={() => void add()}>
          Add profile
        </Button>
        <Button variant="ghost" disabled={busy === 'add'} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  )
}

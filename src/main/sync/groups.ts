import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RemoteConfig, SyncGroup } from '../../shared/types'
import { JsonStore, type SecretCodec } from '../store'
import { rmrf } from '../util/fs'

export type StoredGroup = Omit<SyncGroup, 'hasSecret'>

const SECRET_FIELDS = ['token', 'sshPassphrase'] as const

function stripSecret(remote: RemoteConfig): RemoteConfig {
  const copy = { ...remote }
  for (const f of SECRET_FIELDS) delete copy[f]
  return copy
}

// Profiles (one per repository), secrets encrypted at rest.
export class GroupStore {
  private readonly store: JsonStore<{ groups: StoredGroup[] }>

  constructor(
    private readonly dir: string,
    private readonly codec: SecretCodec
  ) {
    this.store = new JsonStore(path.join(dir, 'groups.json'), () => ({ groups: [] as StoredGroup[] }))
  }

  private transformSecrets(g: StoredGroup, fn: (s: string) => string): StoredGroup {
    const remote = { ...g.remote }
    for (const f of SECRET_FIELDS) if (remote[f]) remote[f] = fn(remote[f]!)
    return { ...g, remote }
  }

  private decrypt(g: StoredGroup): StoredGroup {
    return this.transformSecrets(g, (s) => this.codec.decrypt(s))
  }

  private encrypt(g: StoredGroup): StoredGroup {
    return this.transformSecrets(g, (s) => this.codec.encrypt(s))
  }

  async list(): Promise<StoredGroup[]> {
    return (await this.store.get()).groups.map((g) => this.decrypt(g))
  }

  async get(id: string): Promise<StoredGroup> {
    const g = (await this.list()).find((x) => x.id === id)
    if (!g) throw new Error(`Sync group ${id} not found`)
    return g
  }

  async create(input: { name: string; remote: RemoteConfig }): Promise<StoredGroup> {
    const group: StoredGroup = {
      id: randomUUID(),
      // Placeholder until the repository's modlist.json5 provides the real name.
      name: input.name.trim() || 'Our farm',
      remote: input.remote,
      createdAt: Date.now(),
      lastSyncedAt: null
    }
    await this.store.update((d) => ({ groups: [...d.groups.filter((g) => g.id !== group.id), this.encrypt(group)] }))
    return group
  }

  async update(id: string, patch: { name?: string; remote?: Partial<RemoteConfig>; lastSyncedAt?: number | null }): Promise<StoredGroup> {
    const current = await this.get(id)
    const remotePatch = { ...(patch.remote ?? {}) } as Partial<RemoteConfig>
    // An empty secret in a patch means "keep the stored one".
    for (const f of SECRET_FIELDS) if (remotePatch[f] === '') delete remotePatch[f]
    const next: StoredGroup = {
      ...current,
      name: patch.name?.trim() || current.name,
      remote: { ...current.remote, ...remotePatch } as RemoteConfig,
      lastSyncedAt: patch.lastSyncedAt === undefined ? current.lastSyncedAt : patch.lastSyncedAt
    }
    await this.store.update((d) => ({ groups: d.groups.map((g) => (g.id === id ? this.encrypt(next) : g)) }))
    return next
  }

  async remove(id: string): Promise<void> {
    await this.store.update((d) => ({ groups: d.groups.filter((g) => g.id !== id) }))
    await rmrf(this.workDir(id))
  }

  toPublic(g: StoredGroup): SyncGroup {
    return { ...g, remote: stripSecret(g.remote), hasSecret: SECRET_FIELDS.some((f) => Boolean(g.remote[f])) }
  }

  workDir(id: string): string {
    return path.join(this.dir, 'sync-work', id)
  }
}

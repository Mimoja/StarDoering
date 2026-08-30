import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { AppSettings, ModInfo, ModlistEntry, PullTrigger, RemoteConfig, ServerConfigPullEvent, ServerConfigPullResult, ServerConfigPushResult, ServerConfigRevertResult, ServerConfigRow, ServerConfigView, SyncCommit, SyncGroup, SyncProgress, SyncState } from '../shared/types'
import type { CatalogService } from './catalog'
import type { GameService } from './game'
import type { ModLibrary } from './library'
import { normalizeModFolder, parseManifest, scanMods, setModEnabled, type ParsedManifest } from './mods'
import { editModlist, MODLIST_FILE_NAME, parseModlist, sourcesFromUpdateKeys } from './modlist/format'
import type { ModlistService } from './modlist/service'
import type { JsonStore } from './store'
import { findGit, runGit } from './sync/git'
import { GitRemote, RemoteConflictError } from './sync/git-remote'
import type { GroupStore, StoredGroup } from './sync/groups'
import { readHistory } from './sync/history'
import { logScope } from './activity'
import { switchProfileMods } from './mod-stash'
import { errorMessage, isDir, readJsonLenient, readText, rmrf, walk, writeFileAtomic } from './util/fs'

const log = logScope('sync')

export interface ServerConfigDeps {
  groups: GroupStore
  modlist: ModlistService
  game: GameService
  settings: JsonStore<AppSettings>
  userData: string
  catalog: CatalogService
  emit: (p: SyncProgress) => void
  emitState: (s: SyncState) => void
  // Broadcast of finished pulls (automatic ones included).
  emitPull?: (e: ServerConfigPullEvent) => void
  // Move a folder to the OS trash (electron's shell.trashItem). Without it removals delete permanently.
  trash?: (absPath: string) => Promise<void>
  // Captured after a pull installs mods, so every version stays available to other profiles.
  library?: Pick<ModLibrary, 'capture'>
}

// Rows are always presented alphabetically (case-insensitive, by display name), whatever the order in modlist.json5.
function sortRows(rows: ServerConfigRow[]): void {
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

// Network-level failures (no connectivity / DNS) – expected when playing offline, never shown as errors.
function isOfflineError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e)
  return /Could not resolve host|Network is unreachable|Connection timed out|Failed to connect|Cannot reach the git host|Temporary failure in name resolution|nodename nor servname|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(text)
}

// Mod folders live in the repository under mods/<Folder>/ (their config.json included).
const MODS_DIR = 'mods'
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function isJunk(name: string): boolean {
  return JUNK.has(name.toLowerCase())
}

function normalizeText(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}

// Compare modlist texts ignoring the generated header comments (which carry the date).
function normalizeModlist(s: string | null): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .trim()
}

interface RepoMod {
  // Folder name under mods/ in the repository.
  folder: string
  // Absolute path inside the local clone.
  dir: string
  uniqueId: string
  name: string
  version: string
  configText: string | null
}

interface RemoteSnapshot {
  remote: GitRemote
  text: string | null
  // The clone has commits the server does not have (freshly created branch / not pushed yet).
  aheadOfServer: boolean
  // The repository has no files at all.
  empty: boolean
  // Mods stored in the repository, keyed by lower-cased UniqueID.
  repoMods: Map<string, RepoMod>
}

interface FolderDiff {
  // The other side does not exist at all.
  missing: boolean
  same: boolean
  configChanged: boolean
}

interface Change {
  kind: 'added' | 'removed' | 'enabled' | 'disabled' | 'note' | 'files' | 'files-added' | 'files-removed' | 'config' | 'created'
  name: string
  detail?: string
}

// The repository is the server config: modlist.json5 plus the mod folders under mods/<Folder>/.
// Pull = fetch → apply flags → install listed mods from the repo; push = local selection + draft → commit + push.
export class ServerConfigService {
  // Last modlist text seen on the remote, per group – lets draft edits work without another fetch.
  private readonly remoteText = new Map<string, string | null>()
  // Serialises repository operations per group (a fetch must never reset the clone while a push is running).
  private readonly locks = new Map<string, Promise<unknown>>()
  private state: SyncState = { groupId: null, status: 'idle', message: null, lastPullAt: null, lastPushAt: null, lastError: null, online: true }

  constructor(private readonly deps: ServerConfigDeps) {}

  private withLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(groupId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.locks.set(groupId, next)
    return next
  }

  // Global pull/push state

  getState(): SyncState {
    return { ...this.state }
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.emitState(this.getState())
  }

  private failState(e: unknown): void {
    const message = errorMessage(e)
    const offline = isOfflineError(e)
    this.setState({ status: offline ? 'offline' : 'error', message: offline ? 'Offline – using the last known server config.' : message, lastError: message, online: !offline })
  }

  // Pull the active profile without ever throwing (start, before Play, manual pulls) – failures only update the state.
  // With `timeoutMs` the caller stops waiting after that time (e.g. to launch the game) while the pull keeps running.
  async pullQuietly(opts: { timeoutMs?: number; trigger?: PullTrigger } = {}): Promise<ServerConfigPullResult | null> {
    const group = await this.activeGroup()
    if (!group) {
      this.setState({ groupId: null, status: 'idle', message: 'No profile configured.' })
      return null
    }
    if (this.state.status === 'pulling' || this.state.status === 'pushing') return null
    const run = this.pull({ trigger: opts.trigger ?? 'manual' }).catch(() => null) // pull() already recorded the failure in the state
    if (!opts.timeoutMs) return run
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs)
    })
    try {
      return await Promise.race([run, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  // Active group

  async activeGroup(): Promise<StoredGroup | null> {
    const settings = await this.deps.settings.get()
    // Chosen "local mods only": stay there. Falling back to the first profile would silently undo it.
    if (settings.localModsOnly) return null
    const groups = await this.deps.groups.list()
    const active = groups.find((g) => g.id === settings.activeGroupId) ?? groups[0] ?? null
    if (active && active.id !== settings.activeGroupId) await this.deps.settings.update({ activeGroupId: active.id })
    return active
  }

  async setActive(groupId: string | null): Promise<AppSettings> {
    const previous = (await this.deps.settings.get()).activeGroupId ?? null
    if (previous !== groupId) await this.swapMods(previous, groupId)
    const next = await this.deps.settings.update({ activeGroupId: groupId, localModsOnly: groupId == null })
    if (groupId) void this.pullQuietly({ trigger: 'switch' }) // apply the newly selected config (adds/updates only – nothing is removed)
    return next
  }

  /**
   * Give the incoming profile its own Mods/ folder. Without this the mods someone installed by hand
   * stay behind and show up as part of the next profile.
   *
   * A failure here must not strand the user on the old profile, so it is reported and swallowed –
   * the switch still happens, and the following pull reinstalls what the repository lists.
   */
  private async swapMods(previous: string | null, next: string | null): Promise<void> {
    try {
      const info = await this.deps.game.getInfo()
      if (!info.gameDir || !info.modsDir) return
      await switchProfileMods(info.gameDir, info.modsDir, previous, next, { trash: this.deps.trash })
    } catch (e) {
      log.fail('Could not swap the mod folder for the new profile', e)
    }
  }

  // Add a repository and take the profile name from its modlist.json5 right away; a repository without a config
  // keeps the placeholder until `create()` seeds one.
  async addGroup(input: { name?: string; remote: RemoteConfig }): Promise<SyncGroup> {
    log.info(`Adding the repository ${input.remote.url}`)
    const created = await this.deps.groups.create({ name: input.name ?? '', remote: input.remote })
    try {
      await this.adoptName(created)
    } catch (e) {
      // offline or not yet accessible – the name is adopted on the next successful fetch
      log.warn(`The repository could not be read yet: ${errorMessage(e)}`)
    }
    return this.deps.groups.toPublic(await this.deps.groups.get(created.id))
  }

  // Fetch the repository and take the profile name from its modlist.json5 (no-op when it has none).
  private async adoptName(group: StoredGroup): Promise<void> {
    const { text } = await this.withLock(group.id, () => this.fetchRemote(group))
    const name = text != null ? parseModlist(text).modlist?.name?.trim() : ''
    if (name && name !== group.name) await this.deps.groups.update(group.id, { name })
  }

  private async requireGroup(): Promise<StoredGroup> {
    const group = await this.activeGroup()
    if (!group) throw new Error('No repository configured. Add one on the dashboard first.')
    return group
  }

  // Repository access

  private cloneDir(group: StoredGroup): string {
    return this.deps.groups.workDir(group.id)
  }

  private async remoteFor(group: StoredGroup): Promise<GitRemote> {
    const s = await this.deps.settings.get()
    return new GitRemote(group.remote, this.cloneDir(group), { name: s.authorName.trim() || 'StarDöring', email: s.authorEmail.trim() || 'stardoring@localhost' })
  }

  // Clone or fetch, then hand back the connected remote.
  private async openRemote(group: StoredGroup): Promise<GitRemote> {
    const remote = await this.remoteFor(group)
    this.deps.emit({ groupId: group.id, phase: 'connect', message: 'Connecting…' })
    await remote.connect((message) => this.deps.emit({ groupId: group.id, phase: 'connect', message }))
    return remote
  }

  // Commit history of a profile's clone; `fetch` pulls the remote first.
  async history(groupId: string, limit = 30, opts: { fetch?: boolean } = {}): Promise<SyncCommit[]> {
    const group = await this.deps.groups.get(groupId)
    if (opts.fetch) await this.withLock(group.id, () => this.openRemote(group))
    return readHistory(this.cloneDir(group), limit)
  }

  // Mods stored in the clone's mods/ folder (a folder counts when it has a parseable manifest.json).
  private async readRepoMods(group: StoredGroup): Promise<Map<string, RepoMod>> {
    const out = new Map<string, RepoMod>()
    const root = path.join(this.cloneDir(group), MODS_DIR)
    if (!(await isDir(root))) return out
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      let manifest: ParsedManifest
      try {
        manifest = parseManifest(await readJsonLenient(path.join(dir, 'manifest.json')))
      } catch {
        continue
      }
      if (!manifest.uniqueId) continue
      out.set(manifest.uniqueId.toLowerCase(), { folder: entry.name, dir, uniqueId: manifest.uniqueId, name: manifest.name, version: manifest.version, configText: await readText(path.join(dir, 'config.json')) })
    }
    return out
  }

  private async snapshot(group: StoredGroup, remote: GitRemote): Promise<RemoteSnapshot> {
    const buf = await remote.read(MODLIST_FILE_NAME)
    const text = buf ? buf.toString('utf8') : null
    this.remoteText.set(group.id, text)
    const files = await remote.list('')
    return { remote, text, empty: files.length === 0, repoMods: await this.readRepoMods(group), aheadOfServer: await remote.hasUnpushedCommits() }
  }

  // The clone as it lies on disk – no network. Null before the first clone, or when the clone sits on
  // another branch than the profile's.
  private async cachedRemote(group: StoredGroup): Promise<RemoteSnapshot | null> {
    if (!(await isDir(this.cloneDir(group)))) return null
    try {
      const current = (await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: this.cloneDir(group), timeoutMs: 10_000 })).stdout.trim()
      if (current !== (group.remote.branch || 'main').trim()) return null
    } catch {
      return null
    }
    return this.snapshot(group, await this.remoteFor(group))
  }

  // Recent fetch results, so a burst of view() calls (UI re-renders) does not hit the server every time.
  private readonly recentFetch = new Map<string, { at: number; snap: RemoteSnapshot }>()
  private static readonly FETCH_REUSE_MS = 3000

  private async fetchRemote(group: StoredGroup, opts: { reuseRecent?: boolean } = {}): Promise<RemoteSnapshot> {
    const recent = this.recentFetch.get(group.id)
    if (opts.reuseRecent && recent && Date.now() - recent.at < ServerConfigService.FETCH_REUSE_MS) return recent.snap
    const snap = await this.fetchRemoteNow(group)
    this.recentFetch.set(group.id, { at: Date.now(), snap })
    return snap
  }

  private async fetchRemoteNow(group: StoredGroup): Promise<RemoteSnapshot> {
    const remote = await this.openRemote(group)
    // A branch that is not on the server yet starts as an empty history: seed it with a config right away
    // (committed locally, published by the first push).
    if ((await remote.isEmptyHistory()) && !(await remote.read(MODLIST_FILE_NAME))) {
      const seed = editModlist(null, (m) => m, { name: group.name })
      await remote.write(MODLIST_FILE_NAME, Buffer.from(seed, 'utf8'))
      await remote.commitLocal(`Create server config "${group.name}"\n\nCreated an empty server config\n`)
      log.info(`Created an empty server config for "${group.name}" (local commit – push to publish it)`)
    }
    return this.snapshot(group, remote)
  }

  private async headCommit(group: StoredGroup): Promise<string | null> {
    const [head] = await readHistory(this.cloneDir(group), 1)
    return head?.hash ?? null
  }

  // Mod folder comparison / copying

  private async diffFolders(localDir: string, repoDir: string): Promise<FolderDiff> {
    if (!(await isDir(repoDir)) || !(await isDir(localDir))) return { missing: true, same: false, configChanged: true }
    const skip = (_rel: string, e: { name: string }): boolean => isJunk(e.name)
    const [a, b] = await Promise.all([walk(localDir, { skip }), walk(repoDir, { skip })])
    const sizes = new Map(a.map((f) => [f.rel, f.size]))
    let same = a.length === b.length && b.every((f) => sizes.get(f.rel) === f.size)
    const [lc, rc] = await Promise.all([readText(path.join(localDir, 'config.json')), readText(path.join(repoDir, 'config.json'))])
    const configChanged = (lc ?? '') !== (rc ?? '') && normalizeText(lc ?? '') !== normalizeText(rc ?? '')
    if (configChanged) same = false
    if (same) {
      // Same shape – still compare the small text files that matter (manifest is versioned, config is user data).
      const [lm, rm] = await Promise.all([readText(path.join(localDir, 'manifest.json')), readText(path.join(repoDir, 'manifest.json'))])
      if (normalizeText(lm ?? '') !== normalizeText(rm ?? '')) same = false
    }
    return { missing: false, same, configChanged }
  }

  // Replace `dest` with a copy of `src` (junk files skipped).
  private async replaceFolder(src: string, dest: string): Promise<void> {
    await rmrf(dest)
    await fs.cp(src, dest, { recursive: true, filter: (p) => !isJunk(path.basename(p)) })
  }

  // Copy `src` over `dest` without deleting files that only exist in `dest` (mods may keep caches there).
  private async overlayFolder(src: string, dest: string): Promise<void> {
    await fs.cp(src, dest, { recursive: true, force: true, filter: (p) => !isJunk(path.basename(p)) })
  }

  // Draft

  private draftFile(groupId: string): string {
    return path.join(this.deps.userData, 'modlist-draft', `${groupId}.json5`)
  }

  private getDraft(groupId: string): Promise<string | null> {
    return readText(this.draftFile(groupId))
  }

  private async setDraft(groupId: string, text: string | null): Promise<void> {
    if (text == null) await rmrf(this.draftFile(groupId))
    else await writeFileAtomic(this.draftFile(groupId), text)
  }

  // Discard the draft (added mods, flags, notes, rename) and pull, so the repository's files, flags and configs are
  // re-applied. The only operation that drops a draft – a plain pull keeps it; unlisted mods are not touched.
  async revert(): Promise<ServerConfigPullResult> {
    const group = await this.requireGroup()
    await this.setDraft(group.id, null)
    log.info(`Reverting local changes of "${group.name}" to the server config`)
    return this.pull({ trigger: 'manual' })
  }

  async discardDraft(): Promise<void> {
    const group = await this.requireGroup()
    await this.setDraft(group.id, null)
  }

  // Take the repository's config.json back for `ids` (UniqueIDs; every differing mod without them). Reads the local
  // clone only – no network, so it is instant and works offline.
  async revertConfigs(ids?: string[]): Promise<ServerConfigRevertResult> {
    const group = await this.requireGroup()
    const result: ServerConfigRevertResult = { reverted: [], cleared: [], errors: [] }
    const snap = await this.withLock(group.id, () => this.cachedRemote(group))
    if (!snap) throw new Error('Nothing has been fetched from this repository yet – pull first.')
    const wanted = ids && ids.length > 0 ? new Set(ids.map((i) => i.toLowerCase())) : null
    const modsDir = this.deps.game.requireModsDir()
    for (const mod of await scanMods(modsDir)) {
      if (!mod.uniqueId) continue
      const key = mod.uniqueId.toLowerCase()
      if (wanted && !wanted.has(key)) continue
      const repo = snap.repoMods.get(key)
      if (!repo) continue
      const file = path.join(mod.folderPath, 'config.json')
      const local = await readText(file)
      try {
        if (repo.configText != null) {
          if (local != null && normalizeText(local) === normalizeText(repo.configText)) continue
          await writeFileAtomic(file, repo.configText)
          result.reverted.push(mod.name)
          log.info(`Took the repository's settings back for "${mod.name}"`, { detail: file })
        } else if (local != null) {
          // The repository has no settings for this mod, so reverting means not having any either.
          if (this.deps.trash) await this.deps.trash(file)
          else await rmrf(file)
          result.cleared.push(mod.name)
          log.info(`Removed the local config.json of "${mod.name}" – the repository has none`, { detail: file })
        }
      } catch (err) {
        log.fail(`Reverting the settings of "${mod.name}" failed`, err)
        result.errors.push(`${mod.name}: ${errorMessage(err)}`)
      }
    }
    const touched = result.reverted.length + result.cleared.length
    log.info(touched ? `Reverted the settings of ${touched} mod${touched === 1 ? '' : 's'} to the repository` : 'No settings differed from the repository')
    return result
  }

  // The text edits apply to: the draft if one exists, else the last known remote text (fetching once if unknown).
  private async baseText(group: StoredGroup): Promise<string | null> {
    const draft = await this.getDraft(group.id)
    if (draft != null) return draft
    if (!this.remoteText.has(group.id)) await this.withLock(group.id, () => this.fetchRemote(group))
    return this.remoteText.get(group.id) ?? null
  }

  // Catalog + edits

  // Add entries (from the catalog or elsewhere) to the config draft; existing IDs are left untouched.
  async addEntries(entries: ModlistEntry[]): Promise<void> {
    const group = await this.requireGroup()
    if (entries.length === 0) throw new Error('Nothing to add.')
    const text = editModlist(await this.baseText(group), (mods) => {
      const present = new Set(mods.map((m) => String(m.id ?? '').toLowerCase()))
      for (const e of entries) if (!present.has(e.id.toLowerCase())) mods.push({ ...e, enabled: e.enabled ?? true })
      return mods
    }, { name: group.name })
    await this.setDraft(group.id, text)
  }

  // Put installed-but-unlisted mods into the config draft (entries with name + page sources from their manifest UpdateKeys).
  async addInstalled(ids: string[]): Promise<void> {
    const info = await this.deps.game.getInfo()
    if (!info.modsDir) throw new Error('Stardew Valley was not found.')
    const wanted = new Set(ids.map((i) => i.toLowerCase()))
    const entries: ModlistEntry[] = []
    for (const m of await scanMods(info.modsDir)) {
      if (m.isBundled || !m.uniqueId || !wanted.has(m.uniqueId.toLowerCase())) continue
      const src = sourcesFromUpdateKeys(m.updateKeys)
      const entry: ModlistEntry = { id: m.uniqueId, name: m.name, enabled: m.enabled }
      if (src.nexus) entry.nexus = src.nexus
      if (src.github) entry.github = src.github
      entries.push(entry)
    }
    if (entries.length === 0) throw new Error('None of the requested mods are installed here.')
    await this.addEntries(entries)
  }

  async addFromCatalog(ids: string[]): Promise<void> {
    const items = ids.map((id) => this.deps.catalog.get(id)).filter((i): i is NonNullable<typeof i> => i != null)
    if (items.length === 0) throw new Error('None of the requested mods are in the catalog (is the dataset loaded?).')
    await this.addEntries(items.map((i) => this.deps.catalog.toEntry(i)))
  }

  // Take a mod out of the server config (a draft edit, published on the next push). It stays installed here –
  // nothing is deleted or trashed.
  async removeFromConfig(id: string): Promise<void> {
    const group = await this.requireGroup()
    const mod = await this.installedMod(id) // also refuses SMAPI's bundled mods
    let listed = false
    const text = editModlist(await this.baseText(group), (mods) => {
      const kept = mods.filter((m) => String(m.id ?? '').toLowerCase() !== id.toLowerCase())
      listed = kept.length !== mods.length
      return kept
    }, { name: group.name })
    if (!listed) throw new Error(`${mod?.name ?? id} is not in the server config.`)
    log.info(`Removed "${mod?.name ?? id}" from the server config – it stays installed here; push to publish`)
    await this.setDraft(group.id, text)
  }


  private async installedMod(id: string): Promise<{ uniqueId: string; name: string; folder: string; folderPath: string; enabled: boolean } | null> {
    const { modsDir } = await this.deps.game.getInfo()
    if (!modsDir) return null
    const mods = await scanMods(modsDir)
    const mod = mods.find((m) => m.uniqueId.toLowerCase() === id.toLowerCase()) ?? mods.find((m) => m.folder === id)
    // SMAPI's own bundled mods (Console Commands, Save Backup, …) are never part of a server config and must never
    // be renamed, trashed or listed – every edit path goes through here, so refuse them at the source.
    if (mod?.isBundled) throw new Error(`"${mod.name}" ships with SMAPI and cannot be changed by StarDöring.`)
    return mod ? { uniqueId: mod.uniqueId || mod.folder, name: mod.name, folder: mod.folder, folderPath: mod.folderPath, enabled: mod.enabled } : null
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const group = await this.requireGroup()
    log.info(`${enabled ? 'Enabling' : 'Disabling'} ${id} in the server config`)
    const mod = await this.installedMod(id)
    if (mod) await setModEnabled(this.deps.game.requireModsDir(), mod.folder, enabled)
    // Record the flag in the draft as well, so not-installed mods (and the next push) reflect it.
    const base = await this.baseText(group)
    if (base != null || !mod) {
      const text = editModlist(base, (list) => {
        const hit = list.find((m) => String(m.id ?? '').toLowerCase() === id.toLowerCase())
        if (hit) hit.enabled = enabled
        else if (!mod) throw new Error(`Mod ${id} is neither installed nor in the config`)
        return list
      }, { name: group.name })
      await this.setDraft(group.id, text)
    }
  }

  // Rename the server (the `name` in modlist.json5) via the draft; the profile's display name follows immediately
  // so the UI does not wait for the push.
  async setName(name: string): Promise<void> {
    const group = await this.requireGroup()
    const trimmed = name.trim()
    if (!trimmed) throw new Error('The server name must not be empty.')
    const text = editModlist(await this.baseText(group), (mods) => mods, { name: trimmed, root: (root) => { root.name = trimmed } })
    await this.setDraft(group.id, text)
    await this.deps.groups.update(group.id, { name: trimmed })
  }

  // The user's own note for a mod (free text, stored in the config). Empty clears it.
  async setNote(id: string, note: string): Promise<void> {
    const group = await this.requireGroup()
    const trimmed = note.trim()
    const mod = await this.installedMod(id)
    const text = editModlist(await this.baseText(group), (list) => {
      let hit = list.find((m) => String(m.id ?? '').toLowerCase() === id.toLowerCase())
      if (!hit) {
        if (!mod) throw new Error(`Mod ${id} is neither installed nor in the config`)
        hit = { id: mod.uniqueId, name: mod.name, enabled: mod.enabled }
        list.push(hit)
      }
      if (trimmed) hit.note = trimmed
      else delete hit.note
      return list
    }, { name: group.name })
    await this.setDraft(group.id, text)
  }

  // View

  private emptyView(group: StoredGroup | null, gitAvailable: boolean, warnings: string[] = []): ServerConfigView {
    return {
      group: group ? this.deps.groups.toPublic(group) : null,
      gitAvailable,
      stale: false,
      remoteEmpty: true,
      hasModlist: false,
      modlistName: null,
      modlistText: null,
      modlistErrors: [],
      warnings,
      smapi: null,
      rows: [],
      draft: false,
      unpushed: false,
      changes: [],
      checkedAt: Date.now()
    }
  }

  private configState(localConfig: string | null, repo: RepoMod | undefined): ServerConfigRow['configState'] {
    const r = repo?.configText ?? null
    if (localConfig == null && r == null) return 'none'
    if (localConfig == null) return 'remote-only'
    if (r == null) return 'unpushed'
    return normalizeText(localConfig) === normalizeText(r) ? 'synced' : 'unpushed'
  }

  // Description for a row: the installed manifest first, then the catalog's page tagline.
  private describeMod(id: string, installedDescription: string | null | undefined): string | null {
    const own = installedDescription?.trim()
    if (own) return own
    const cat = this.deps.catalog.get(id)?.description?.trim()
    return cat || null
  }

  // SMAPI's own mods: listed under "Installed" for completeness, never part of the config, no actions.
  private bundledRow(m: ModInfo): ServerConfigRow {
    return {
      id: m.uniqueId || m.folder,
      name: m.name,
      description: this.describeMod(m.uniqueId, m.description),
      inConfig: false,
      configEnabled: null,
      installed: true,
      localEnabled: m.enabled,
      installedVersion: m.version,
      latestVersion: null,
      state: 'installed',
      folder: m.folder,
      pageUrl: null,
      inRepo: false,
      bundled: true,
      repoVersion: null,
      optional: false,
      note: null,
      configState: 'none',
      errors: []
    }
  }

  // Build the unified row list from the modlist status (or, without a modlist, from the installed mods).
  private async buildRows(text: string | null, repoMods: Map<string, RepoMod>): Promise<Pick<ServerConfigView, 'rows' | 'smapi' | 'modlistName' | 'modlistErrors' | 'warnings' | 'hasModlist'> & { folderDiffers: boolean }> {
    const info = await this.deps.game.getInfo()
    const installed = info.modsDir ? await scanMods(info.modsDir) : []
    const byId = new Map(installed.filter((m) => m.uniqueId).map((m) => [m.uniqueId.toLowerCase(), m]))
    const localConfig = async (id: string): Promise<string | null> => {
      const m = byId.get(id.toLowerCase())
      return m?.hasConfig ? readText(path.join(m.folderPath, 'config.json')) : null
    }
    let folderDiffers = false
    const differs = async (id: string): Promise<boolean> => {
      const m = byId.get(id.toLowerCase())
      const r = repoMods.get(id.toLowerCase())
      if (!m || !r) return Boolean(m && !r)
      const d = await this.diffFolders(m.folderPath, r.dir)
      return !d.same
    }

    if (text != null) {
      const status = await this.deps.modlist.status(text)
      const rows: ServerConfigRow[] = []
      for (const e of status.entries) {
        const key = e.entry.id.toLowerCase()
        const repo = repoMods.get(key)
        const isInstalled = e.installedVersion != null
        if (isInstalled && (await differs(e.entry.id))) folderDiffers = true
        rows.push({
          id: e.entry.id,
          name: e.entry.name ?? e.entry.id,
          description: this.describeMod(e.entry.id, byId.get(key)?.description),
          inConfig: true,
          configEnabled: e.desiredEnabled,
          installed: isInstalled,
          localEnabled: isInstalled ? (e.enabledMismatch ? !e.desiredEnabled : e.desiredEnabled) : null,
          installedVersion: e.installedVersion,
          latestVersion: e.latestVersion,
          state: e.state,
          folder: e.installedFolder,
          pageUrl: e.pageUrl,
          github: e.githubRepo,
          inRepo: repo != null,
          bundled: false,
          repoVersion: repo?.version ?? null,
          optional: Boolean(e.entry.optional),
          note: e.entry.note ?? null,
          configState: this.configState(await localConfig(e.entry.id), repo),
          errors: e.errors
        })
      }
      for (const x of status.extra) {
        const repo = repoMods.get(x.uniqueId.toLowerCase())
        rows.push({
          id: x.uniqueId || x.folder,
          name: x.name,
          description: this.describeMod(x.uniqueId, byId.get(x.uniqueId.toLowerCase())?.description),
          inConfig: false,
          configEnabled: null,
          installed: true,
          localEnabled: x.enabled,
          installedVersion: x.version,
          latestVersion: null,
          state: 'extra',
          folder: x.folder,
          pageUrl: null,
          inRepo: repo != null,
          bundled: false,
          repoVersion: repo?.version ?? null,
          optional: false,
          note: null,
          configState: this.configState(await localConfig(x.uniqueId), repo),
          errors: []
        })
      }
      for (const m of installed.filter((x) => x.isBundled)) rows.push(this.bundledRow(m))
      sortRows(rows)
      return { rows, smapi: status.smapi, modlistName: status.modlist?.name ?? null, modlistErrors: status.errors, warnings: status.warnings, hasModlist: status.modlist != null, folderDiffers }
    }
    const rows: ServerConfigRow[] = []
    for (const m of installed) {
      const repo = repoMods.get(m.uniqueId.toLowerCase())
      rows.push({
        id: m.uniqueId || m.folder,
        name: m.name,
        description: this.describeMod(m.uniqueId, m.description),
        inConfig: false,
        configEnabled: null,
        installed: true,
        localEnabled: m.enabled,
        installedVersion: m.version,
        latestVersion: null,
        state: 'extra',
        folder: m.folder,
        pageUrl: null,
        inRepo: repo != null,
        bundled: m.isBundled,
        repoVersion: repo?.version ?? null,
        optional: false,
        note: null,
        configState: this.configState(m.hasConfig ? await readText(path.join(m.folderPath, 'config.json')) : null, repo),
        errors: m.manifestErrors
      })
    }
    sortRows(rows)
    return { rows, smapi: null, modlistName: null, modlistErrors: [], warnings: [], hasModlist: false, folderDiffers: false }
  }

  // `fetch: false` reads the local clone instead of talking to the remote – instant, and offline-proof.
  async view(opts: { fetch?: boolean } = {}): Promise<ServerConfigView> {
    const git = await findGit()
    const group = await this.activeGroup()
    if (!group) return this.emptyView(null, git.available, ['No repository configured yet. Add one on the dashboard.'])
    if (!git.available) return this.emptyView(group, false, ['Git is not installed.'])

    log.debug(`Reading the server config of "${group.name}"${opts.fetch === false ? ' (local copy)' : ''}`)
    let snap: RemoteSnapshot | null = null
    const stale = opts.fetch === false
    if (stale) {
      // Instant path for profile switches: read the local clone WITHOUT the profile lock (a background pull
      // may hold it for seconds) and never touch the network – the caller fetches in the background.
      snap = await this.cachedRemote(group)
      if (!snap) {
        const view = this.emptyView(group, true, ['Fetching this profile for the first time…'])
        return { ...view, stale: true }
      }
    } else {
      try {
        snap = await this.withLock(group.id, () => this.fetchRemote(group, { reuseRecent: true }))
        this.deps.emit({ groupId: group.id, phase: 'done' })
      } catch (e) {
        this.deps.emit({ groupId: group.id, phase: 'error', message: errorMessage(e) })
        throw e
      }
    }
    const draft = await this.getDraft(group.id)
    const text = draft ?? snap.text
    const { folderDiffers, ...built } = await this.buildRows(text, snap.repoMods)
    // The server's display name is the name in the repository's modlist.json5.
    if (built.modlistName && built.modlistName.trim() && built.modlistName.trim() !== group.name) {
      await this.deps.groups.update(group.id, { name: built.modlistName.trim() })
    }
    const unpushed =
      draft != null ||
      snap.aheadOfServer ||
      !built.hasModlist ||
      folderDiffers ||
      built.rows.some((r) => (r.installed && r.configEnabled != null && r.localEnabled !== r.configEnabled) || (r.installed && r.inConfig && !r.inRepo))
    const changes = unpushed ? await this.pendingChanges(group, snap, text).catch(() => [] as string[]) : []
    return {
      changes,
      group: this.deps.groups.toPublic(await this.deps.groups.get(group.id)),
      gitAvailable: true,
      stale,
      remoteEmpty: snap.empty,
      ...built,
      modlistText: text,
      aheadOfServer: snap.aheadOfServer,
      draft: draft != null,
      unpushed,
      checkedAt: Date.now()
    }
  }

  // Pull

  async pull(opts: { trigger?: PullTrigger } = {}): Promise<ServerConfigPullResult> {
    const trigger: PullTrigger = opts.trigger ?? 'manual'
    const group = await this.requireGroup()
    const result: ServerConfigPullResult = { message: '', toggled: [], installed: [], missing: [], configsApplied: 0, errors: [] }
    // Pulls only add/update: a pull never removes anything from the Mods folder, not even after switching profiles –
    // unlisted mods stay and show as "extra".
    this.setState({ groupId: group.id, status: 'pulling', message: 'Pulling server config…', lastError: null })
    log.info(`Pulling the server config of "${group.name}"`)
    const startedAt = Date.now()
    try {
      const snap = await this.withLock(group.id, () => this.fetchRemote(group))
      // Unpushed draft edits survive a pull: the draft is the intended local state, so flags and installs follow it;
      // only Revert discards it.
      const draft = await this.getDraft(group.id)
      const text = draft ?? snap.text
      if (draft != null) log.info(`Unpushed draft edits of "${group.name}" are kept – applying the draft on top of the fetched repository`)
      if (text == null) {
        log.warn(`The repository has no ${MODLIST_FILE_NAME} yet – push to create it`)
        result.message = `The repository has no ${MODLIST_FILE_NAME} yet – push to create it.`
        await this.deps.groups.update(group.id, { lastSyncedAt: Date.now() })
        this.deps.emit({ groupId: group.id, phase: 'done' })
        this.setState({ status: 'idle', message: result.message, lastPullAt: Date.now(), online: true })
        this.deps.emitPull?.({ ...result, trigger, groupId: group.id })
        return result
      }
      const modsDir = this.deps.game.requireModsDir()
      const applyFlags = async (): Promise<void> => {
        const status = await this.deps.modlist.status(text)
        for (const e of status.entries) {
          if (!e.installedFolder || !e.enabledMismatch) continue
          try {
            await setModEnabled(modsDir, e.installedFolder, e.desiredEnabled)
            result.toggled.push(`${e.entry.name ?? e.entry.id} → ${e.desiredEnabled ? 'enabled' : 'disabled'}`)
          } catch (err) {
            log.fail(`Could not ${e.desiredEnabled ? 'enable' : 'disable'} "${e.entry.name ?? e.entry.id}"`, err)
            result.errors.push(errorMessage(err))
          }
        }
      }
      await applyFlags()

      // Install / update every listed mod from the repository.
      this.setState({ message: 'Installing mods from the repository…' })
      const status = await this.deps.modlist.status(text)
      let touched = false
      for (const e of status.entries) {
        const name = e.entry.name ?? e.entry.id
        const repo = snap.repoMods.get(e.entry.id.toLowerCase())
        if (!repo) {
          if (e.installedVersion == null) {
            log.warn(`"${name}" is listed but nobody has pushed its files yet – install it from its page and push`)
            result.missing.push(name)
          }
          continue
        }
        try {
          if (e.installedFolder) {
            const localDir = path.join(modsDir, ...e.installedFolder.split('/'))
            const d = await this.diffFolders(localDir, repo.dir)
            if (d.same) continue
            await this.overlayFolder(repo.dir, localDir)
            if (d.configChanged) result.configsApplied++
            log.info(`Updated "${name}" ${repo.version} from the repository${d.configChanged ? ' (config.json applied)' : ''}`, { detail: localDir })
            result.installed.push(`${name} (updated)`)
          } else {
            const folder = e.desiredEnabled ? repo.folder : `.${repo.folder}`
            await this.replaceFolder(repo.dir, path.join(modsDir, folder))
            if (repo.configText != null) result.configsApplied++
            log.info(`Installed "${name}" ${repo.version} from the repository`, { detail: path.join(modsDir, folder) })
            result.installed.push(name)
          }
          touched = true
        } catch (err) {
          log.fail(`Installing "${name}" from the repository failed`, err)
          result.errors.push(`${name}: ${errorMessage(err)}`)
        }
      }
      if (touched) await applyFlags() // freshly installed mods may need to be disabled per config
      // Keep a copy of every version that ever landed in Mods/ (shared across profiles, enables roll-backs).
      if (this.deps.library) {
        try {
          await this.deps.library.capture(modsDir)
        } catch (err) {
          log.warn(`Mod library capture failed: ${errorMessage(err)}`)
        }
      }

      const parts = ['Server config pulled']
      if (result.installed.length) parts.push(`${result.installed.length} installed/updated`)
      if (result.toggled.length) parts.push(`${result.toggled.length} toggled`)
      if (result.configsApplied) parts.push(`${result.configsApplied} config${result.configsApplied === 1 ? '' : 's'} applied`)
      if (result.missing.length) parts.push(`not in the repository yet: ${result.missing.join(', ')}`)
      if (result.errors.length) parts.push(`${result.errors.length} error(s)`)
      result.message = parts.join(' · ')
      log.info(result.message, { durationMs: Date.now() - startedAt, detail: [...result.toggled, ...result.errors].join('\n') })
      await this.deps.groups.update(group.id, { lastSyncedAt: Date.now() })
      this.deps.emit({ groupId: group.id, phase: 'done' })
      this.setState({ status: 'idle', message: result.message, lastPullAt: Date.now(), online: true })
      this.deps.emitPull?.({ ...result, trigger, groupId: group.id })
      return result
    } catch (e) {
      if (isOfflineError(e)) log.warn(`Offline – keeping the last known server config of "${group.name}"`, { detail: errorMessage(e) })
      else log.fail(`Pulling the server config of "${group.name}" failed`, e)
      this.deps.emit({ groupId: group.id, phase: 'error', message: errorMessage(e) })
      this.failState(e)
      throw e
    }
  }

  // What a push would do right now, worded exactly like the commit it would create (kept in step with pushWith).
  private async pendingChanges(group: StoredGroup, snap: RemoteSnapshot, text: string | null): Promise<string[]> {
    const modlistText = await this.deps.modlist.generate(text, { name: group.name, onlyListed: true })
    const finalIds = new Set((parseModlist(modlistText).modlist?.mods ?? []).map((e) => e.id.toLowerCase()))
    const changes = this.listChanges(snap.text, modlistText)
    const info = await this.deps.game.getInfo()
    const installed = info.modsDir ? await scanMods(info.modsDir) : []
    const keep = new Set<string>()
    for (const m of installed) {
      if (m.isBundled || !m.uniqueId || !finalIds.has(m.uniqueId.toLowerCase())) continue
      const folder = path.basename(normalizeModFolder(m.folder))
      keep.add(folder.toLowerCase())
      const d = await this.diffFolders(m.folderPath, path.join(this.cloneDir(group), MODS_DIR, folder))
      if (!d.same) changes.push({ kind: d.missing ? 'files-added' : d.configChanged ? 'config' : 'files', name: m.name, detail: m.version })
    }
    for (const r of snap.repoMods.values()) {
      if (!finalIds.has(r.uniqueId.toLowerCase()) && !keep.has(r.folder.toLowerCase())) changes.push({ kind: 'files-removed', name: r.name })
    }
    return this.describe(changes).details
  }

  // Push

  // Human-readable change list between two modlist texts.
  private listChanges(before: string | null, after: string): Change[] {
    const prev = before ? parseModlist(before).modlist : null
    const next = parseModlist(after).modlist
    if (!next) return []
    const changes: Change[] = []
    if (!prev) {
      changes.push({ kind: 'created', name: next.name, detail: `${next.mods.length} mod${next.mods.length === 1 ? '' : 's'}` })
      return changes
    }
    const label = (e: ModlistEntry): string => e.name ?? e.id
    const prevById = new Map(prev.mods.map((e) => [e.id.toLowerCase(), e]))
    const nextById = new Map(next.mods.map((e) => [e.id.toLowerCase(), e]))
    for (const [key, e] of nextById) {
      const p = prevById.get(key)
      if (!p) {
        changes.push({ kind: 'added', name: label(e), detail: e.id })
        continue
      }
      const pe = p.enabled !== false
      const ne = e.enabled !== false
      if (pe !== ne) changes.push({ kind: ne ? 'enabled' : 'disabled', name: label(e) })
      if ((p.note ?? '') !== (e.note ?? '')) changes.push({ kind: 'note', name: label(e), detail: e.note ?? '' })
    }
    for (const [key, p] of prevById) if (!nextById.has(key)) changes.push({ kind: 'removed', name: label(p), detail: p.id })
    return changes
  }

  private describe(changes: Change[]): { subject: string; details: string[] } {
    const names = (kind: Change['kind']): string[] => changes.filter((c) => c.kind === kind).map((c) => c.name)
    const parts: string[] = []
    const created = changes.find((c) => c.kind === 'created')
    if (created) parts.push(`Create server config "${created.name}" (${created.detail})`)
    const add = (verb: string, list: string[]): void => {
      if (list.length === 0) return
      parts.push(list.length <= 3 ? `${verb} ${list.join(', ')}` : `${verb} ${list.slice(0, 2).join(', ')} and ${list.length - 2} more`)
    }
    add('Add', names('added'))
    add('Remove', names('removed'))
    add('Enable', names('enabled'))
    add('Disable', names('disabled'))
    add('Note for', names('note'))
    add('Add files of', names('files-added'))
    add('Update files of', names('files'))
    add('Remove files of', names('files-removed'))
    add('Update config of', names('config'))
    let subject = parts.join('; ') || 'Update server config'
    if (subject.length > 100) subject = `${subject.slice(0, 97)}…`
    // The wording is the only marker: the UI colours each line by its verb (see lib/changes.ts).
    const wording: Record<Change['kind'], string> = {
      created: 'Created server config',
      added: 'Added',
      removed: 'Removed',
      enabled: 'Enabled',
      disabled: 'Disabled',
      note: 'Note for',
      files: 'Files updated:',
      'files-added': 'Files added:',
      'files-removed': 'Files removed:',
      config: 'Config changed:'
    }
    const details = changes.map((c) => `${wording[c.kind]} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
    return { subject, details }
  }

  private async pushWith(group: StoredGroup, existingText: string | null): Promise<ServerConfigPushResult> {
    const settings = await this.deps.settings.get()
    if (!settings.authorName.trim() || !settings.authorEmail.trim()) throw new Error('Set your name and e-mail (git author) on the dashboard before pushing.')
    this.setState({ groupId: group.id, status: 'pushing', message: 'Pushing server config…', lastError: null })
    log.info(`Pushing the server config of "${group.name}"`)
    const startedAt = Date.now()
    try {
      const pushed = await this.withLock(group.id, async () => {
        let lastError: unknown = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          const { remote, text: remoteBefore, repoMods } = await this.fetchRemote(group)
          const modlistText = await this.deps.modlist.generate(existingText, { name: group.name, onlyListed: true })
          const finalIds = new Set((parseModlist(modlistText).modlist?.mods ?? []).map((e) => e.id.toLowerCase()))
          const changes = this.listChanges(remoteBefore, modlistText)
          const modlistChanged = normalizeModlist(remoteBefore) !== normalizeModlist(modlistText)

          // Mod folders: every installed mod that is in the list goes into mods/<Folder>/.
          const info = await this.deps.game.getInfo()
          const installed = info.modsDir ? await scanMods(info.modsDir) : []
          const modsRoot = path.join(this.cloneDir(group), MODS_DIR)
          let modsPushed = 0
          const keep = new Set<string>()
          for (const m of installed) {
            if (m.isBundled || !m.uniqueId || !finalIds.has(m.uniqueId.toLowerCase())) continue // SMAPI's own mods are never pushed
            const key = m.uniqueId.toLowerCase()
            const folder = path.basename(normalizeModFolder(m.folder))
            const existing = repoMods.get(key)
            const target = path.join(modsRoot, folder)
            if (existing && existing.folder !== folder) await rmrf(existing.dir) // renamed locally – move in the repo too
            keep.add(folder.toLowerCase())
            const d = await this.diffFolders(m.folderPath, target)
            if (d.same) continue
            await this.replaceFolder(m.folderPath, target)
            modsPushed++
            log.info(`${d.missing ? 'Adding' : 'Updating'} the files of "${m.name}" ${m.version} in the repository`, { detail: `mods/${folder}` })
            changes.push({ kind: d.missing ? 'files-added' : d.configChanged ? 'config' : 'files', name: m.name, detail: m.version })
          }
          // Folders of unlisted mods leave the repository.
          for (const r of repoMods.values()) {
            if (!finalIds.has(r.uniqueId.toLowerCase()) && !keep.has(r.folder.toLowerCase())) {
              await rmrf(r.dir)
              modsPushed++
              log.info(`Removing the files of "${r.name}" from the repository`, { detail: `mods/${r.folder}` })
              changes.push({ kind: 'files-removed', name: r.name })
            }
          }
          let { subject, details } = this.describe(changes)
          if (!modlistChanged && modsPushed === 0) {
            // Only local commits to publish (e.g. a freshly created branch): say so instead of "Update server config".
            subject = `Publish branch "${(group.remote.branch || 'main').trim()}"`
            details = ['Published local commits']
          }
          const ahead = await remote.hasUnpushedCommits()
          if (!modlistChanged && modsPushed === 0 && !ahead) {
            log.info('Nothing to push – the server config is up to date')
            await this.setDraft(group.id, null)
            this.recentFetch.delete(group.id)
            this.deps.emit({ groupId: group.id, phase: 'done' })
            return { message: 'Nothing to push – the server config is up to date.', commit: null, modlistText, modsPushed: 0, details: [] }
          }
          if (modlistChanged) await remote.write(MODLIST_FILE_NAME, Buffer.from(modlistText, 'utf8'))
          this.deps.emit({ groupId: group.id, phase: 'commit', message: 'Pushing…' })
          try {
            await remote.commit(`${subject}\n\n${details.join('\n')}\n`)
          } catch (e) {
            if (e instanceof RemoteConflictError && attempt < 3) {
              lastError = e
              continue // someone pushed in between – re-fetch and retry on top of their version
            }
            throw e
          }
          await this.setDraft(group.id, null)
          this.remoteText.set(group.id, modlistText)
          this.recentFetch.delete(group.id) // the cached snapshot predates this push
          const commit = await this.headCommit(group)
          log.info(`Pushed${commit ? ` ${commit}` : ''}: ${subject}`, { durationMs: Date.now() - startedAt, detail: details.join('\n') })
          await this.deps.groups.update(group.id, { lastSyncedAt: Date.now() })
          this.deps.emit({ groupId: group.id, phase: 'done' })
          return { message: `Pushed${commit ? ` ${commit}` : ''}: ${subject}`, commit, modlistText, modsPushed, details }
        }
        throw lastError instanceof Error ? lastError : new Error('Push kept being rejected – try again.')
      })
      this.setState({ status: 'idle', message: pushed.message, lastPushAt: Date.now(), online: true })
      return pushed
    } catch (e) {
      log.fail(`Pushing the server config of "${group.name}" failed`, e)
      this.deps.emit({ groupId: group.id, phase: 'error', message: errorMessage(e) })
      this.failState(e)
      throw e
    }
  }

  async push(): Promise<ServerConfigPushResult> {
    const group = await this.requireGroup()
    const draft = await this.getDraft(group.id)
    if (draft != null) return this.pushWith(group, draft)
    if (!this.remoteText.has(group.id)) await this.withLock(group.id, () => this.fetchRemote(group))
    return this.pushWith(group, this.remoteText.get(group.id) ?? null)
  }

  // Create the active profile's missing branch – from an existing branch (`from`) or empty with a new config
  // (`from: null`) – and push it so every device can use it.
  async initBranch(opts: { from: string | null }): Promise<ServerConfigPushResult> {
    const group = await this.requireGroup()
    const settings = await this.deps.settings.get()
    if (!settings.authorName.trim() || !settings.authorEmail.trim()) throw new Error('Set your name and e-mail (git author) on the dashboard before pushing.')
    const branch = (group.remote.branch || 'main').trim()
    const source = opts.from?.trim() || null
    if (source === branch) throw new Error('Pick a different branch to start from.')
    this.setState({ groupId: group.id, status: 'pushing', message: source ? `Creating branch "${branch}" from "${source}"…` : `Creating branch "${branch}" with a new config…`, lastError: null })
    try {
      const pushed = await this.withLock(group.id, async () => {
        const remote = await this.openRemote(group) // missing branch → the clone is an empty history for it
        let modlistText: string
        let subject: string
        if (source) {
          await remote.createBranchFrom(source)
          const buf = await remote.read(MODLIST_FILE_NAME)
          modlistText = buf ? buf.toString('utf8') : editModlist(null, (m) => m, { name: group.name })
          if (!buf) await remote.write(MODLIST_FILE_NAME, Buffer.from(modlistText, 'utf8'))
          subject = `Create branch "${branch}" from "${source}"`
        } else {
          modlistText = editModlist(null, (m) => m, { name: group.name })
          await remote.write(MODLIST_FILE_NAME, Buffer.from(modlistText, 'utf8'))
          subject = `Create server config "${group.name}" (empty)`
        }
        this.deps.emit({ groupId: group.id, phase: 'commit', message: 'Pushing…' })
        await remote.commit(`${subject}\n\n${source ? `Started from branch ${source}` : 'Created an empty server config'}\n`)
        await this.setDraft(group.id, null)
        this.remoteText.set(group.id, modlistText)
        this.recentFetch.delete(group.id)
        const commit = await this.headCommit(group)
        await this.deps.groups.update(group.id, { lastSyncedAt: Date.now() })
        this.deps.emit({ groupId: group.id, phase: 'done' })
        return { message: `${subject}${commit ? ` (${commit})` : ''}`, commit, modlistText, modsPushed: 0, details: [source ? `Started from branch ${source}` : 'Created an empty server config'] }
      })
      this.setState({ status: 'idle', message: pushed.message, lastPushAt: Date.now(), online: true })
      return pushed
    } catch (e) {
      this.deps.emit({ groupId: group.id, phase: 'error', message: errorMessage(e) })
      this.failState(e)
      throw e
    }
  }

  async create(): Promise<ServerConfigPushResult> {
    const group = await this.requireGroup()
    return this.pushWith(group, await this.getDraft(group.id))
  }
}

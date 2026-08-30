// Shared type contract between the Electron main process and the renderer.
// Everything crossing the IPC boundary must be plain JSON-serialisable data.

export type Platform = 'win32' | 'darwin' | 'linux'

// Game / SMAPI detection

export type GameSource = 'steam' | 'gog' | 'xbox' | 'manual' | 'unknown'

export interface GameCandidate {
  // Directory that contains `Stardew Valley.dll` (on macOS: .../Contents/MacOS).
  path: string
  source: GameSource
  version: string | null
  hasSmapi: boolean
}

export interface SmapiInfo {
  installed: boolean
  version: string | null
  // Executable/script to launch the game through SMAPI.
  launcherPath: string | null
}

// Linux: whether the game's Galaxy libraries had their executable-stack flag cleared (glibc 2.41+ refuses them otherwise).
export type GalaxyLibsState = 'patched' | 'unpatched' | null

export interface GameInfo {
  platform: Platform
  found: boolean
  gameDir: string | null
  gameVersion: string | null
  source: GameSource
  candidates: GameCandidate[]
  smapi: SmapiInfo
  // ~/.config/StardewValley or %APPDATA%\StardewValley
  dataDir: string
  savesDir: string
  savesDirExists: boolean
  modsDir: string | null
  smapiLogPath: string | null
  // Parsed from the last SMAPI log run, if present.
  lastRun: { smapiVersion: string | null; gameVersion: string | null; os: string | null; at: string | null } | null
  galaxyLibs: GalaxyLibsState
  running: boolean
}

export type LaunchMode = 'smapi' | 'vanilla' | 'steam'

// Mods

export type ModKind = 'smapi' | 'content-pack' | 'unknown'

export interface ModDependency {
  uniqueId: string
  minimumVersion?: string
  isRequired: boolean
}

export interface ModInfo {
  // Folder path relative to Mods/, using forward slashes.
  folder: string
  folderPath: string
  // SMAPI ignores folders whose name starts with a dot – that is how we disable mods.
  enabled: boolean
  name: string
  author: string
  version: string
  description: string
  uniqueId: string
  kind: ModKind
  contentPackFor?: { uniqueId: string; minimumVersion?: string }
  entryDll?: string
  minimumApiVersion?: string
  minimumGameVersion?: string
  dependencies: ModDependency[]
  updateKeys: string[]
  hasConfig: boolean
  manifestErrors: string[]
  sizeBytes: number
  fileCount: number
  // Ships with SMAPI (Console Commands, Save Backup, Error Handler). Handled like any other mod, except that the
  // update check skips them: they are versioned with SMAPI itself and never in the catalog.
  isBundled: boolean
  // Required dependencies (by unique ID) that are not installed/enabled.
  missingDependencies: string[]
}

// Saves

export interface SaveInfo {
  folder: string
  path: string
  farmerName: string
  farmName: string
  day: number
  season: string
  year: number
  hoursPlayed: number
  money: number
  gameVersion: string | null
  lastModified: number
  sizeBytes: number
  hasBackup: boolean
}

// Sync

export interface GitRemoteConfig {
  kind: 'git'
  // HTTPS or SSH clone URL, e.g. https://github.com/you/mods.git or git@github.com:you/mods.git
  url: string
  branch: string
  // Optional private key used for SSH URLs (GIT_SSH_COMMAND -i). null/undefined = system default (ssh-agent, ~/.ssh/config).
  sshKeyPath?: string | null
  // Passphrase for an encrypted SSH key (secret; stored encrypted, never sent to the renderer). Empty = rely on ssh-agent.
  sshPassphrase?: string
  // Optional HTTPS credentials. The token is a secret (stored encrypted, never sent to the renderer).
  username?: string
  token?: string
  authorName?: string
  authorEmail?: string
}

// Sync is git-only: the repository *is* the group.
export type RemoteConfig = GitRemoteConfig

export interface GitInfo {
  available: boolean
  path: string | null
  version: string | null
}

export interface SshKeyInfo {
  name: string
  path: string
}

export interface SyncGroup {
  id: string
  // Display name – the `name` inside the repository's modlist.json5 (read when the repository is added).
  name: string
  // Secrets are stripped before this reaches the renderer; `hasSecret` tells the UI one is stored.
  remote: RemoteConfig
  hasSecret: boolean
  createdAt: number
  lastSyncedAt: number | null
}

// One commit of a group's repository (from the local clone, newest first).
export interface SyncCommit {
  // Short hash, e.g. "a1b2c3d".
  hash: string
  // First line of the commit message.
  subject: string
  author: string
  // Author date, ms since epoch.
  at: number
  // Files touched compared to the parent commit.
  filesChanged: number
  // Mod folders touched (paths under mods/<folder>/), deduped, at most 8 – empty for config-only commits.
  modsChanged: string[]
  // The commit the local clone currently points at (what the last pull/push used).
  current: boolean
  // Change list from the commit body (one line per change; empty for commits made outside the app).
  details: string[]
}

export type SyncStatus = 'idle' | 'pulling' | 'pushing' | 'offline' | 'error'

// Global pull/push state of the active profile (broadcast as `sync:state`).
export interface SyncState {
  groupId: string | null
  status: SyncStatus
  // Last progress or result message.
  message: string | null
  lastPullAt: number | null
  lastPushAt: number | null
  lastError: string | null
  // False after a network failure (offline); pulls are then skipped silently until the next attempt.
  online: boolean
}

export interface SyncProgress {
  groupId: string
  phase: 'connect' | 'commit' | 'done' | 'error'
  message?: string
}

export interface BranchInfo {
  // The profile's configured branch.
  current: string
  branches: string[]
  exists: boolean
}

// App settings

export interface AppSettings {
  gameDirOverride: string | null
  savesDirOverride: string | null
  // The sync group (git repository) whose server config is shown/applied.
  activeGroupId: string | null
  // "Local mods only" was chosen deliberately. Without this a null activeGroupId is ambiguous – it
  // means both "no profile picked yet" (where falling back to the first one is helpful) and "play
  // with local mods" (where doing so overrides the choice on every start).
  localModsOnly: boolean
  // Git author used for every commit made from the UI (required before pushing).
  authorName: string
  authorEmail: string
}

export interface SmapiInstallResult {
  ok: boolean
  message: string
  version?: string
  // The installed build already matched the latest release – nothing was downloaded or run.
  alreadyCurrent?: boolean
}

export interface ModInstallResult {
  installed: string[]
  errors: string[]
}

// Modlist – the group's declarative mod set (modlist.json5 in the sync repo)

export interface ModlistEntry {
  // SMAPI UniqueID – primary key, compared case-insensitively.
  id: string
  name?: string
  // Nexus mod ID (the number in the mod page URL).
  nexus?: number
  // GitHub "owner/repo" whose releases publish the mod zip.
  github?: string
  // Substring that picks the right asset when a release contains several zips.
  githubAsset?: string
  // Fallback mod page or direct download URL (a ".zip" URL is installed automatically).
  url?: string
  // Omitted = "latest"; otherwise a minimum version.
  version?: string
  // Not required on every device.
  optional?: boolean
  // false = the mod stays installed but switched off (dot-prefixed folder). Omitted = true.
  enabled?: boolean
  note?: string
}

export interface Modlist {
  name: string
  // "latest" or a minimum SMAPI version.
  smapi: string
  mods: ModlistEntry[]
}

export interface ModlistParseResult {
  // Null when the document is unusable (invalid JSON5, no `mods` array). Invalid entries are skipped and listed in `errors`.
  modlist: Modlist | null
  errors: string[]
  warnings: string[]
}

export type ModlistEntryState = 'installed' | 'outdated' | 'missing' | 'disabled'

export interface ModlistEntryStatus {
  entry: ModlistEntry
  // installed = present & enabled & new enough · outdated = below the minimum (or latest) · disabled = present but dot-folder · missing = not installed
  state: ModlistEntryState
  installedVersion: string | null
  // Folder relative to Mods/ (usable with api.mods.setEnabled / open / remove).
  installedFolder: string | null
  // What the modlist wants (entry.enabled !== false).
  desiredEnabled: boolean
  // Installed, but the local enabled state differs from `desiredEnabled`.
  enabledMismatch: boolean
  latestVersion: string | null
  pageUrl: string | null
  githubRepo: string | null
  // Non-fatal notes from the version lookup.
  errors: string[]
}

export interface ModlistExtraMod {
  folder: string
  uniqueId: string
  name: string
  version: string
  enabled: boolean
}

export interface ModlistSmapiStatus {
  required: string
  installed: string | null
  latest: string | null
  ok: boolean
  message: string
}

export interface ModlistStatus {
  modlist: Modlist | null
  errors: string[]
  warnings: string[]
  entries: ModlistEntryStatus[]
  // Installed mods that are not in the modlist.
  extra: ModlistExtraMod[]
  smapi: ModlistSmapiStatus
}

// What a GitHub repository publishes as its newest version – fetched on demand, never in bulk.
export interface GithubRelease {
  // "owner/repo".
  repo: string
  // Tag with a leading "v" stripped.
  version: string
  url: string
  publishedAt: string | null
  // Whether it came from a published release or, failing that, the newest tag.
  source: 'release' | 'tag'
}

// Server config – unified view of the active group's repository + modlist.json5

export type ServerConfigRowState = ModlistEntryState | 'extra'

export interface ServerConfigRow {
  // SMAPI UniqueID.
  id: string
  name: string
  // From the installed manifest.json, else the catalog (page tagline); null when neither has one.
  description: string | null
  // Listed in modlist.json5.
  inConfig: boolean
  // enabled flag in the server config (null when not listed).
  configEnabled: boolean | null
  installed: boolean
  // Local enabled state (null when not installed).
  localEnabled: boolean | null
  installedVersion: string | null
  latestVersion: string | null
  // installed / outdated / missing / disabled for listed mods; extra = installed but not listed (added on push).
  state: ServerConfigRowState
  // Folder relative to Mods/ when installed.
  folder: string | null
  pageUrl: string | null
  // "owner/repo" when the mod is published on GitHub – what the manual GitHub check needs. Optional so row
  // constructors that know nothing about it stay valid.
  github?: string | null
  // The mod's files are in the repository (mods/<Folder>/) – Pull installs it from there.
  inRepo: boolean
  // Ships with SMAPI (Console Commands, Save Backup): shown under "Installed" with a "built-in" tag, never part of the config, no actions.
  bundled: boolean
  // Version of the copy stored in the repository (null when not in the repo). "Pull to install/update" applies only when this is newer than `installedVersion`.
  repoVersion: string | null
  optional: boolean
  // The user's own note (free text, stored in the config).
  note: string | null
  // config.json inside the mod folder: none anywhere · synced (local == repo) · unpushed (local differs from / missing in repo) · remote-only (repo has one, local not yet).
  configState: 'none' | 'synced' | 'unpushed' | 'remote-only'
  errors: string[]
}

export interface ServerConfigView {
  group: SyncGroup | null
  gitAvailable: boolean
  /** Read from the local clone without contacting the server (instant, may lag behind) – a background fetch follows. */
  stale: boolean
  // The repository has no commits yet.
  remoteEmpty: boolean
  hasModlist: boolean
  modlistName: string | null
  modlistText: string | null
  modlistErrors: string[]
  warnings: string[]
  smapi: ModlistSmapiStatus | null
  rows: ServerConfigRow[]
  // The local clone has commits the server does not have (e.g. a freshly created branch) – Push publishes them.
  aheadOfServer?: boolean
  // Unpushed edits to the modlist (catalog additions, enable flags of not-installed mods) exist locally.
  draft: boolean
  // Local selection/files differ from the server config – a push would change the repository.
  unpushed: boolean
  // What that push would do, one line per change, worded like the commit it would create (empty = in step).
  changes: string[]
  checkedAt: number
}

// Catalog – Pathoschild's StardewModDataset, cloned locally and indexed by UniqueID

export interface CatalogItem {
  // SMAPI UniqueID.
  id: string
  name: string
  author: string
  kind: 'smapi' | 'content-pack'
  // Latest known version (from the newest download's manifest or the mod page).
  version: string | null
  // Mod page last updated (ms since epoch).
  updated: number | null
  // How many other mods depend on this one or are a content pack for it – the dataset has no ratings or download
  // counts, so this stands in for "how essential is it".
  requiredBy: number
  // The mod's own description from its manifest, when the dataset has one.
  description: string | null
  // Every page the dataset knows for this mod (one per store) plus its repository.
  pages: { label: string; url: string }[]
  pageUrl: string | null
  nexus: number | null
  curseforge: number | null
  moddrop: number | null
  // "owner/repo" from the manifest's UpdateKeys, when present.
  github: string | null
  // Title of the dataset page when it bundles several mods – the row itself is named after the manifest then.
  pageName: string | null
  // The framework this content pack is for (UniqueID and, when the dataset knows it, its name).
  contentPackFor: { id: string; name: string } | null
  // Mods the manifest depends on, without the content-pack framework above.
  needs: { id: string; name: string }[]
}

// One stored mod version in the local library (shared by every profile on this computer).
export interface LibraryEntry {
  // SMAPI UniqueID.
  id: string
  version: string
  name: string
  // Folder name it was installed under, without the dot that marks a mod disabled.
  folder: string
  // When this version was taken into the library.
  addedAt: number
  sizeBytes: number
}

export interface CatalogStatus {
  // An index is loaded (possibly from a previous start while updating).
  ready: boolean
  updating: boolean
  count: number
  // Dataset commit the index was built from.
  commit: string | null
  updatedAt: number | null
  // Last clone/pull problem (offline etc.); the previous index stays usable.
  error: string | null
}

export interface ServerConfigPullResult {
  message: string
  // Mods whose enabled state was changed locally to match the config.
  toggled: string[]
  // Mods installed or updated from the repository's mods/ folder.
  installed: string[]
  // Listed mods whose files nobody has pushed yet – open their page (Install) and add the zip, then Push.
  missing: string[]
  // config.json files written into local mod folders from the repository.
  configsApplied: number
  errors: string[]
}

// What started a pull: a profile/branch switch, app start, the Play button, or the user (Pull button / ↻).
export type PullTrigger = 'switch' | 'start' | 'play' | 'manual'

// Broadcast as `serverConfig:pull` whenever a pull finishes, automatic or not.
export type ServerConfigPullEvent = ServerConfigPullResult & { trigger: PullTrigger; groupId: string }

export interface ServerConfigPushResult {
  message: string
  // Short hash of the pushed commit, or null when there was nothing to push.
  commit: string | null
  modlistText: string
  // Mod folders written into (or removed from) the repository.
  modsPushed: number
  // The change list that went into the commit message.
  details: string[]
}

// Mods folder changes noticed while the app runs

export interface ModsChangeEvent {
  // Mod folders (relative to Mods/) whose config.json changed, appeared or vanished.
  configs: string[]
  // Mod folders that appeared or vanished.
  folders: string[]
}

// SMAPI log viewer

export interface SmapiLog {
  // Resolved SMAPI-latest.txt path, null when the game data folder is unknown.
  path: string | null
  // The tail of the file, newest content last (starts at a line boundary when truncated).
  text: string
  // Full file size in bytes.
  size: number
  // `text` is only the tail of a larger file.
  truncated: boolean
  // No log file yet.
  missing: boolean
}

// Logging – every notable action of the main process, shown on the Logs page

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Which part of the app produced a message.
export type LogSource = 'app' | 'game' | 'git' | 'sync' | 'mods' | 'modlist' | 'catalog' | 'smapi'

export interface LogEntry {
  // Monotonic counter, unique per app run – also the React key.
  seq: number
  // ms since epoch.
  at: number
  level: LogLevel
  source: LogSource
  message: string
  // Extra multi-line context (command output, stack trace, change list).
  detail?: string
  // Duration of the operation the entry reports, in ms.
  durationMs?: number
}

export interface LogFileInfo {
  path: string
  exists: boolean
  sizeBytes: number
}


// Mod config menu – the settings inside a mod's own config.json

// Anything that can sit in a config.json.
export type ModConfigValue = string | number | boolean | null | ModConfigValue[] | { [key: string]: ModConfigValue }

// boolean/number/string come from the value in config.json; choice/choices from a mod that documents its allowed
// values (Content Patcher's ConfigSchema). Arrays and anything else stay 'json' and are edited as raw JSON.
export type ModConfigFieldType = 'boolean' | 'number' | 'string' | 'choice' | 'choices' | 'json'

export interface ModConfigField {
  // Where the setting sits in the config object, e.g. ["Controls", "OpenMenu"]. Joined by "." it is also the row key.
  path: string[]
  // The key, spaced out for reading ("UseCustomSpeed" → "Use custom speed").
  label: string
  // Parent path joined by " › " for nested settings; null at the top level.
  section: string | null
  type: ModConfigFieldType
  value: ModConfigValue
  // The mod author's default, when the mod documents one.
  default: ModConfigValue | null
  hasDefault: boolean
  description: string | null
  // Allowed values for 'choice' (pick one) and 'choices' (comma-separated list).
  choices: string[] | null
  // Whole numbers only.
  integer: boolean
}

export interface ModConfigDoc {
  // Folder relative to Mods/.
  folder: string
  modName: string
  uniqueId: string
  // Absolute path of config.json.
  path: string
  exists: boolean
  // Raw file text for the JSON editor; null when there is no config.json.
  text: string | null
  // Where descriptions, allowed values and defaults come from – nothing else documents mod settings.
  schemaSource: 'none' | 'content-patcher'
  fields: ModConfigField[]
  // config.json could not be parsed – only the JSON editor is offered.
  parseError: string | null
  // The file has more settings than the form shows; the JSON editor has all of them.
  truncated: boolean
  // No config.json yet, but the mod documents its settings – they can be written out without starting the game.
  canCreate: boolean
}

export interface ModConfigEdit {
  path: string[]
  value: ModConfigValue
}

// stardoering:// links

// "Add this repository as a profile", from a `stardoering://add-profile?url=…` link.
export interface DeepLinkAddProfile {
  kind: 'addProfile'
  // Clone URL, already validated (https/http/ssh, or scp-style git@host:path – nothing else).
  url: string
  branch: string
  // Name carried by the link; a placeholder until the repository's modlist.json5 provides the real one.
  name: string | null
}

export type DeepLink = DeepLinkAddProfile

// What the main process hands the renderer when the OS opens a stardoering:// link (or refuses to).
export type DeepLinkEvent = { link: DeepLink } | { error: string }

// Outcome of taking the repository's mod settings back (api.serverConfig.revertConfigs).
export interface ServerConfigRevertResult {
  // Mods whose config.json was replaced with the repository's copy.
  reverted: string[]
  // Mods whose local config.json was removed because the repository has none.
  cleared: string[]
  errors: string[]
}

// Steam non-Steam shortcut ("Add to Steam")

export interface SteamShortcutStatus {
  steamFound: boolean
  // Steam is running – shortcuts.vdf cannot be changed safely until it quits.
  running: boolean
  // Steam accounts found on this computer.
  accounts: number
  // StarDöring is present as a non-Steam game for every account.
  installed: boolean
  // Executable the shortcut points at.
  exe: string
  message: string
}

// AppImage ("Install to home")

export interface AppImageStatus {
  // The app is running from an AppImage – only then can it install itself.
  running: boolean
  // The running AppImage file, null when not running as one.
  source: string | null
  // Where "Install to home" puts it (~/.bin/StarDoering.AppImage).
  target: string
  // A copy already sits at `target`.
  installed: boolean
  // The running AppImage *is* the installed copy – nothing left to do.
  current: boolean
  // Where the application-menu entry goes (~/.local/share/applications/stardoering.desktop).
  desktopFile: string
  // That entry exists.
  desktopInstalled: boolean
}

// ---------------------------------------------------------------------------
// Installing a GitHub-hosted mod (latest release asset) with live progress
// ---------------------------------------------------------------------------

export interface GithubInstallRequest {
  /** Mod UniqueID (for progress events and the library). */
  id: string
  name: string
  /** "owner/repo". */
  repo: string
  /** Substring that picks the right zip when a release has several. */
  asset?: string | null
}

export interface GithubInstallProgress {
  id: string
  name: string
  repo: string
  phase: 'resolving' | 'downloading' | 'installing' | 'done' | 'error'
  /** Bytes so far / total (total is null when GitHub sends no Content-Length). */
  received: number
  total: number | null
  message: string
  version: string | null
  installed: string[]
}

// Self-update from the GitHub releases of StarDöring itself

// How this copy is replaced: the AppImage file, the unpacked AppImage install, the NSIS installer, the portable exe,
// the macOS bundle – or not at all: a deb needs root and is only announced, a dev run has no release.
export type UpdateMethod = 'appimage' | 'unpacked' | 'deb' | 'nsis' | 'portable' | 'mac' | 'none'

export interface UpdateAsset {
  name: string
  url: string
  size: number | null
}

export interface UpdateState {
  // idle = not checked yet (or the check failed); available = found but not installed on its own (`message` says why).
  phase: 'idle' | 'current' | 'available' | 'downloading' | 'installing' | 'restarting' | 'error'
  currentVersion: string
  latestVersion: string | null
  // The release page on GitHub.
  releaseUrl: string
  // The release file for this computer, null when the release has none for it.
  asset: UpdateAsset | null
  method: UpdateMethod
  // True while the start-up updater holds the window; the app view renders once it is false.
  gate: boolean
  // Download progress in bytes (total is null without a Content-Length).
  received: number
  total: number | null
  message: string
  checkedAt: number | null
}

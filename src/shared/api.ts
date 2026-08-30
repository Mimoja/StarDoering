import type {
  ModsChangeEvent,
  AppImageStatus,
  AppSettings,
  BranchInfo,
  CatalogItem,
  CatalogStatus,
  DeepLinkEvent,
  GameInfo,
  GithubRelease,
  GitInfo,
  GithubInstallProgress,
  GithubInstallRequest,
  LaunchMode,
  LibraryEntry,
  LogEntry,
  LogFileInfo,
  ModConfigDoc,
  ModConfigEdit,
  ModInfo,
  ModInstallResult,
  RemoteConfig,
  SaveInfo,
  ServerConfigPullEvent,
  ServerConfigPullResult,
  ServerConfigPushResult,
  ServerConfigRevertResult,
  ServerConfigView,
  SmapiInstallResult,
  SmapiLog,
  SshKeyInfo,
  SteamShortcutStatus,
  SyncCommit,
  SyncGroup,
  SyncProgress,
  SyncState,
  UpdateState
} from './types'

export type Unsubscribe = () => void

// The API exposed to the renderer through the preload bridge (`window.api`).
export interface Api {
  game: {
    getInfo(refresh?: boolean): Promise<GameInfo>
    /** Steam installs always start through Steam (SMAPI runs via Steam's launcher/launch options); `warning` explains when SMAPI would be skipped. */
    launch(mode?: LaunchMode): Promise<{ ok: boolean; error?: string; warning?: string }>
    openDir(which: 'game' | 'mods' | 'saves' | 'data' | 'logs'): Promise<void>
    installSmapi(): Promise<SmapiInstallResult>
    // Latest SMAPI release on GitHub (cached an hour); null when offline or rate-limited.
    latestSmapi(): Promise<string | null>
    onExit(cb: (info: { code: number | null }) => void): Unsubscribe
  }
  mods: {
    list(): Promise<ModInfo[]>
    setEnabled(folder: string, enabled: boolean): Promise<void>
    open(folder: string): Promise<void>
    remove(folder: string): Promise<void>
    install(zipPaths?: string[]): Promise<ModInstallResult>
    // The game (GMCM) saved a config.json, a mod folder appeared or vanished – re-read whatever shows mods or their settings.
    onChange(cb: (e: ModsChangeEvent) => void): Unsubscribe
  }
  saves: {
    list(): Promise<SaveInfo[]>
    open(folder?: string): Promise<void>
    // Copy a save into a folder of its own – with a fresh save id, and under `farmName` when one is given.
    duplicate(folder: string, farmName?: string): Promise<SaveInfo>
  }
  sync: {
    listGroups(): Promise<SyncGroup[]>
    // Add a repository; the profile name is read from the modlist.json5 inside it.
    createGroup(input: { name?: string; remote: RemoteConfig }): Promise<SyncGroup>
    updateGroup(id: string, patch: { name?: string; remote?: Partial<RemoteConfig> }): Promise<SyncGroup>
    removeGroup(id: string): Promise<void>
    onProgress(cb: (p: SyncProgress) => void): Unsubscribe
    gitInfo(): Promise<GitInfo>
    // Commit history of the group's local clone, newest first (instant, offline). `fetch: true` pulls the remote first (network).
    history(groupId: string, limit?: number, opts?: { fetch?: boolean }): Promise<SyncCommit[]>
    // Branches on the server for a profile's repository and whether its configured branch exists (network).
    branches(groupId: string): Promise<BranchInfo>
    // The profile's local clone folder, null until it has been fetched once.
    localPath(groupId: string): Promise<string | null>
    // Open a terminal window in the profile's local clone.
    openTerminal(groupId: string): Promise<{ ok: boolean; error?: string }>
    // Current global pull/push state of the active profile.
    state(): Promise<SyncState>
    onState(cb: (s: SyncState) => void): Unsubscribe
    // Pull the active profile now (fetch latest config, apply flags, auto-install listed mods). Never throws for offline/errors – read the state. Null when no profile is configured.
    resync(): Promise<ServerConfigPullResult | null>
  }
  serverConfig: {
    // Compare the active repository with the installed mods. `fetch: false` uses the local clone (instant, offline).
    view(opts?: { fetch?: boolean }): Promise<ServerConfigView>
    // Fetch + apply the server config: install/update listed mods from the repo, apply flags/configs. Never removes anything from the Mods folder and KEEPS unpushed draft edits (only revert() drops them).
    pull(): Promise<ServerConfigPullResult>
    // Fired when any pull finishes (switch / start / play / manual). Toast it unless trigger === 'manual' – the caller of a manual pull already has the result.
    onPull(cb: (r: ServerConfigPullEvent) => void): Unsubscribe
    // Write the local selection (enabled flags, installed mods, mod files) into the repository and push.
    push(): Promise<ServerConfigPushResult>
    // Create a fresh modlist.json5 from the installed mods and push it (first-time setup of a repository).
    create(): Promise<ServerConfigPushResult>
    // The active profile's branch does not exist on the server: create it – from an existing branch's content (`from`), or empty with a new config (`from: null`) – and push it.
    initBranch(opts: { from: string | null }): Promise<ServerConfigPushResult>
    // Tick/untick a mod: renames the folder locally when installed and records the flag in the config draft.
    setEnabled(id: string, enabled: boolean): Promise<void>
    // Add catalog mods (by UniqueID) to the config draft. They show as "missing" until someone installs them and pushes.
    addFromCatalog(ids: string[]): Promise<void>
    // Put mods that are installed here but not listed ("extra" rows) into the config draft; Push never adds them on its own.
    addInstalled(ids: string[]): Promise<void>
    // Remove a mod for good: out of modlist.json5, local folder to the trash, files out of the repository on the next push.
    removeFromConfig(id: string): Promise<void>
    // Rename the server: writes `name` into the config draft (published on push) and updates the profile's display name at once. Empty is rejected.
    setName(name: string): Promise<void>
    // The user's own note for a mod (free text; empty clears it). Stored in the config draft, published on push.
    setNote(id: string, note: string): Promise<void>
    // Take the repository's mod settings back, throwing away local config.json edits. Local clone only – instant and offline; `ids` limits it to those mods.
    revertConfigs(ids?: string[]): Promise<ServerConfigRevertResult>
    // Throw away unpushed config edits.
    discardDraft(): Promise<void>
    // Discard every unpushed local change (draft edits, local flag/config changes of listed mods) and restore the server config: discardDraft + pull.
    revert(): Promise<ServerConfigPullResult>
    // Choose which repository is the active server config.
    setActive(groupId: string | null): Promise<AppSettings>
  }
  github: {
    // Latest release (or newest tag) of "owner/repo". One API call – triggered by the user, never in bulk.
    latestRelease(repo: string): Promise<GithubRelease>
    /** Download the latest release zip and install it into Mods/ (progress via onProgress). Resolves when done or failed – see the last event. */
    install(req: GithubInstallRequest): Promise<GithubInstallProgress>
    onProgress(cb: (p: GithubInstallProgress) => void): Unsubscribe
  }
  // Every mod version this computer has downloaded, shared by all profiles.
  library: {
    // Everything stored, by mod name.
    list(): Promise<LibraryEntry[]>
    // Copy a stored version into the Mods folder, keeping the current folder name and enabled state.
    install(id: string, version: string): Promise<LibraryEntry>
    // Take a copy of anything installed that the library does not have yet.
    capture(): Promise<LibraryEntry[]>
    // Delete one stored version (what is installed stays untouched).
    remove(id: string, version: string): Promise<void>
  }
  catalog: {
    // Index state (cloned/pulled from Pathoschild/StardewModDataset once per start).
    status(): Promise<CatalogStatus>
    onStatus(cb: (s: CatalogStatus) => void): Unsubscribe
    // Substring search over name / UniqueID / author (name-prefix matches first).
    search(query: string, limit?: number): Promise<CatalogItem[]>
    // What to offer before anything is typed: the mods most other mods depend on.
    top(limit?: number): Promise<CatalogItem[]>
  }
  // StarDöring's own log: git, mod install/enable/disable, sync, catalog – everything the app does.
  activity: {
    // The buffered entries, oldest first (at most a few thousand are kept per run).
    list(limit?: number): Promise<LogEntry[]>
    // New entries as they happen, in batches.
    onEntries(cb: (entries: LogEntry[]) => void): Unsubscribe
    // Empty the in-memory buffer (the log file keeps everything).
    clear(): Promise<void>
    file(): Promise<LogFileInfo>
    // Show the log file in the system file manager.
    openFile(): Promise<void>
    // Open the log in a window of its own, or focus the one that is already open.
    openWindow(): Promise<void>
  }
  logs: {
    // Tail of SMAPI-latest.txt (default 256 KB, capped at 8 MB).
    read(maxBytes?: number): Promise<SmapiLog>
    // Watch the log folder; every change (including SMAPI rewriting the file on start) emits a fresh tail.
    watch(maxBytes?: number): Promise<void>
    unwatch(): Promise<void>
    onChange(cb: (log: SmapiLog) => void): Unsubscribe
  }
  steam: {
    // Is StarDöring a non-Steam ("foreign") game in the Steam library of this computer?
    status(): Promise<SteamShortcutStatus>
    // Add it (Steam must be closed; Steam shows it after its next start).
    addShortcut(): Promise<{ ok: boolean; message: string }>
  }
  appimage: {
    // Is this an AppImage, and does a copy already live in ~/.bin?
    status(): Promise<AppImageStatus>
    // Copy the running AppImage to ~/Applications (or ~/.bin) so its path stays stable.
    install(): Promise<{ ok: boolean; message: string; path: string }>
    // Write the .desktop entry and icons that put it in the application menu.
    installDesktop(): Promise<{ ok: boolean; message: string; path: string }>
  }
  // StarDöring's own updates: a newer GitHub release of Mimoja/StarDoering is installed at start and the app restarts into it.
  update: {
    // What is going on, for the Dashboard row and the toasts.
    state(): Promise<UpdateState>
    onState(cb: (s: UpdateState) => void): Unsubscribe
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  // A mod's own settings (its config.json), as a form instead of a text file.
  modConfig: {
    // The settings of one installed mod, with descriptions and defaults when the mod documents them.
    read(folder: string): Promise<ModConfigDoc>
    // Write the changed settings back into config.json; every other key keeps its value.
    save(folder: string, edits: ModConfigEdit[]): Promise<ModConfigDoc>
    // Replace config.json with hand-edited JSON (rejected when it is not valid JSON).
    saveText(folder: string, content: string): Promise<ModConfigDoc>
    // Write out the documented defaults for a mod whose config.json does not exist yet.
    create(folder: string): Promise<ModConfigDoc>
    // Back to the mod's defaults – restored when the mod documents them, otherwise config.json goes to the trash and the mod writes a fresh one at the next launch.
    reset(folder: string): Promise<ModConfigDoc>
  }
  app: {
    version(): Promise<string>
    platform: string
    pickFolder(title?: string, defaultPath?: string): Promise<string | null>
    pickFiles(opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>
    openExternal(url: string): Promise<void>
    // Put text on the system clipboard.
    copyText(text: string): Promise<void>
    listSshKeys(): Promise<SshKeyInfo[]>
    /** Close the app (the sidebar's Exit button – there is no window chrome on a Steam Deck in game mode). */
    quit(): Promise<void>
    // A stardoering:// link that reached the app before this window existed, taken exactly once. Null when there is none.
    takeDeepLink(): Promise<DeepLinkEvent | null>
    // A stardoering:// link opened while the app was already running.
    onDeepLink(cb: (e: DeepLinkEvent) => void): Unsubscribe
  }
}

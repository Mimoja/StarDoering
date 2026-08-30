import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import type { GithubInstallProgress, GithubInstallRequest, AppSettings, CatalogStatus, DeepLinkEvent, LaunchMode, LogEntry, ModConfigEdit, ModsChangeEvent, RemoteConfig, ServerConfigPullEvent, SmapiLog, SyncProgress, SyncState } from '../shared/types'
import { GameService } from './game'
import { ModlistService } from './modlist/service'
import { ServerConfigService } from './server-config'
import { CatalogService } from './catalog'
import { ModLibrary } from './library'
import { fetchLatestGithubRelease, installFromGithub } from './github'
import { activityLog, logScope } from './activity'
import { LogService } from './logs'
import { SmapiLogFeed } from './smapi-feed'
import { ModsWatcher } from './mods-watch'
import { openTerminalAt } from './terminal'
import { launchTarget, SteamShortcutService } from './steam-shortcut'
import * as appimage from './appimage'
import { relaunchInto } from './relaunch'
import { ensureGalaxyLibsLoadable } from './galaxy-fix'
import { smapiLogPath } from './paths'
import { installModZips, scanMods, setModEnabled } from './mods'
import { createModConfig, readModConfigDoc, resetModConfig, saveModConfigText, saveModConfigValues } from './mod-config'
import { duplicateSave, listSaves } from './saves'
import { JsonStore, plainCodec, type SecretCodec } from './store'
import { GroupStore } from './sync/groups'
import { findGit, listSshKeys } from './sync/git'
import { listRemoteBranches } from './sync/git-remote'
import { PROTOCOL, parseDeepLink } from '../shared/protocol'
import { ensureDir, errorMessage, safeJoin, exists } from './util/fs'


/**
 * Electron derives userData from the app name, and from an unpacked install that name comes back
 * empty – which puts the settings, the profile store and the catalog clone directly in ~/.config
 * instead of ~/.config/StarDöring, so an installed copy cannot see what the AppImage set up. Pin
 * both. The value matches what Electron already computed on every platform, so nothing moves.
 */
app.setName('StarDöring')
app.setPath('userData', path.join(app.getPath('appData'), 'StarDöring'))

const userData = app.getPath('userData')
const tempDir = path.join(app.getPath('temp'), 'stardoring')

// The activity log has to exist before anything else logs into it.
activityLog.configure({ file: path.join(userData, 'logs', 'stardoring.log') })
const log = logScope('app')

const codec: SecretCodec = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : plainCodec.encrypt(s)),
  decrypt: (s) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : plainCodec.decrypt(s))
}

const settingsStore = new JsonStore<AppSettings>(path.join(userData, 'settings.json'), () => ({
  gameDirOverride: null,
  savesDirOverride: null,
  activeGroupId: null,
  localModsOnly: false,
  authorName: '',
  authorEmail: ''
}))

const game = new GameService({
  settings: () => settingsStore.get(),
  openExternal: (url) => shell.openExternal(url),
  openPath: (p) => shell.openPath(p),
  tempDir
})

const modlist = new ModlistService({ userData, game, catalog: () => catalog })

const groups = new GroupStore(userData, codec)

// Window (and unpackaged-macOS dock) icon; the packaged app icon comes from electron-builder's .icns/.ico.
const appIcon = app.isPackaged
  ? path.join(__dirname, '../renderer/icon.png')
  : path.join(app.getAppPath(), 'resources', process.platform === 'darwin' ? 'icon-macos.png' : 'icon.png')

let mainWindow: BrowserWindow | null = null
let activityWindow: BrowserWindow | null = null
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    // A renderer that crashed or is closing still shows up here; sending into its disposed frame
    // throws out of whatever emitted the event (an activity-log flush, a catalog status change).
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    try {
      w.webContents.send(channel, payload)
    } catch {
      // Disposed between the check and the send – the next broadcast will skip it.
    }
  }
}

activityLog.onEntries((entries: LogEntry[]) => broadcast('activity:entries', entries))

const logs = new LogService({ logPath: async () => smapiLogPath((await game.getInfo()).dataDir), emit: (log: SmapiLog) => broadcast('logs:change', log) })
// Its own watcher, so the renderer opening/closing the SMAPI log view cannot switch the feed off.
const smapiFeed = new SmapiLogFeed({ logPath: async () => smapiLogPath((await game.getInfo()).dataDir) })
// The game saving a config.json (GMCM), mod folders coming or going.
const modsWatcher = new ModsWatcher({ modsDir: async () => (await game.getInfo()).modsDir, emit: (e: ModsChangeEvent) => broadcast('mods:change', e) })
const catalog = new CatalogService({ userData, emit: (st: CatalogStatus) => broadcast('catalog:status', st) })
const library = new ModLibrary({ userData })
const steamShortcut = new SteamShortcutService(launchTarget({ isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), appImage: appimage.steamExecPath() }))
const serverConfig = new ServerConfigService({ groups, modlist, game, settings: settingsStore, userData, catalog, emit: (p: SyncProgress) => broadcast('sync:progress', p), emitState: (st: SyncState) => broadcast('sync:state', st), emitPull: (e: ServerConfigPullEvent) => broadcast('serverConfig:pull', e), trash: (p: string) => shell.trashItem(p), library })

game.on('exit', (info) => broadcast('game:exit', info))
game.on('info', () => void modsWatcher.sync()) // the Mods folder follows game detection

// The activity log in a window of its own (one at a time; a second call focuses it).
function openActivityWindow(): void {
  if (activityWindow && !activityWindow.isDestroyed()) {
    if (activityWindow.isMinimized()) activityWindow.restore()
    activityWindow.focus()
    return
  }
  activityWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 520,
    minHeight: 320,
    title: 'Activity log – StarDöring',
    icon: appIcon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  activityWindow.once('ready-to-show', () => activityWindow?.show())
  activityWindow.on('closed', () => {
    activityWindow = null
  })
  activityWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Same bundle as the main window; the hash makes the renderer mount the log instead of the app.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void activityWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#activity`)
  } else {
    void activityWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'activity' })
  }
}

function createWindow(): void {
  rendererReady = false
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'StarDöring',
    icon: appIcon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// stardoering:// links

// A link the OS handed us, waiting for a renderer that can show it.
let pendingDeepLink: DeepLinkEvent | null = null
// Flipped once a renderer has asked for queued links; before that a link is only kept.
let rendererReady = false

// Hand the queued link to the renderer, if there is one and it is listening.
function deliverDeepLink(): void {
  if (!pendingDeepLink || !rendererReady) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const event = pendingDeepLink
  pendingDeepLink = null
  mainWindow.webContents.send('deeplink:open', event)
}

// One stardoering:// URL (cold start, second launch or macOS open-url): parse it, bring the window up and
// hand it over. Nothing is cloned here – the renderer asks the user first.
function handleDeepLink(raw: string): void {
  try {
    const link = parseDeepLink(raw)
    log.info(`Opened link ${raw}`, { detail: `repository ${link.url}, branch ${link.branch}` })
    pendingDeepLink = { link }
  } catch (e) {
    log.warn(`Ignoring link ${raw}: ${errorMessage(e)}`)
    pendingDeepLink = { error: errorMessage(e) }
  }
  // A link can arrive before the app is ready (macOS cold start) – a window cannot exist yet, and
  // whenReady() picks the queued link up as soon as the renderer asks for it.
  if (!app.isReady()) return
  focusMainWindow()
  deliverDeepLink()
}

// Windows and Linux deliver the URL as a command line argument.
function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((a) => new RegExp(`^${PROTOCOL}:`, 'i').test(a))
}

// Ask the OS to send us stardoering:// links (macOS also takes this from the bundle's Info.plist).
function registerProtocolClient(): void {
  try {
    // An unpackaged run on Windows/Linux is the electron binary, so the registration has to name the script too.
    const ok =
      app.isPackaged || process.platform === 'darwin'
        ? app.setAsDefaultProtocolClient(PROTOCOL)
        : app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? '')])
    if (ok) log.info(`Registered as the handler for ${PROTOCOL}:// links`)
    else log.warn(`Could not register ${PROTOCOL}:// links with the system`)
  } catch (e) {
    log.warn(`Could not register ${PROTOCOL}:// links: ${errorMessage(e)}`)
  }
}

// macOS delivers links through this event, on a cold start before the app is even ready – so it is
// registered while the module loads rather than inside whenReady().
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

// IPC

function handle<T extends unknown[]>(channel: string, fn: (...args: T) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as T))
    } catch (e) {
      log.error(`${channel} failed: ${errorMessage(e)}`, { detail: e instanceof Error ? e.stack : undefined })
      // Re-throw with a clean message (Electron prefixes "Error invoking remote method …" otherwise).
      throw new Error(errorMessage(e))
    }
  })
}

function registerIpc(): void {
  // game
  handle('game:getInfo', (refresh?: boolean) => game.getInfo(Boolean(refresh)))
  handle('game:launch', async (mode?: LaunchMode) => {
    // Latest server config before playing; offline or failing pulls must never block the launch.
    await serverConfig.pullQuietly({ timeoutMs: 30_000, trigger: 'play' })
    return game.launch(mode ?? 'smapi')
  })
  handle('game:openDir', (which: 'game' | 'mods' | 'saves' | 'data' | 'logs') => game.openDir(which))
  handle('game:installSmapi', () => game.installSmapi())
  handle('game:latestSmapi', () => game.latestSmapi())

  // mods
  handle('mods:list', async () => {
    const info = await game.getInfo()
    return info.modsDir ? scanMods(info.modsDir) : []
  })
  handle('mods:setEnabled', async (folder: string, enabled: boolean) => {
    await setModEnabled(game.requireModsDir(), folder, enabled)
  })
  handle('mods:open', async (folder: string) => {
    await shell.openPath(safeJoin(game.requireModsDir(), folder))
  })
  handle('mods:remove', async (folder: string) => {
    await shell.trashItem(safeJoin(game.requireModsDir(), folder))
  })
  handle('mods:install', async (zipPaths?: string[]) => {
    let paths = zipPaths ?? []
    if (paths.length === 0) {
      const res = await dialog.showOpenDialog({ title: 'Install mods from zip', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Mod archives', extensions: ['zip'] }] })
      if (res.canceled) return { installed: [], errors: [] }
      paths = res.filePaths
    }
    await ensureDir(tempDir)
    const result = await installModZips(game.requireModsDir(), paths, tempDir)
    // Anything that lands in Mods/ joins the library, so every profile can go back to this version later.
    await library.capture(game.requireModsDir()).catch(() => [])
    return result
  })

  // mod config menu – a mod's own settings, as a form over its config.json
  handle('modConfig:read', (folder: string) => readModConfigDoc(game.requireModsDir(), String(folder ?? '')))
  handle('modConfig:save', (folder: string, edits: ModConfigEdit[]) => saveModConfigValues(game.requireModsDir(), String(folder ?? ''), Array.isArray(edits) ? edits : []))
  handle('modConfig:saveText', (folder: string, content: string) => saveModConfigText(game.requireModsDir(), String(folder ?? ''), String(content ?? '')))
  handle('modConfig:create', (folder: string) => createModConfig(game.requireModsDir(), String(folder ?? '')))
  handle('modConfig:reset', (folder: string) => resetModConfig(game.requireModsDir(), String(folder ?? ''), (p) => shell.trashItem(p)))

  // saves
  handle('saves:list', async () => listSaves((await game.getInfo()).savesDir))
  handle('saves:open', async (folder?: string) => {
    const dir = (await game.getInfo()).savesDir
    await shell.openPath(folder ? safeJoin(dir, folder) : dir)
  })
  handle('saves:duplicate', async (folder: string, farmName?: string) =>
    duplicateSave((await game.getInfo()).savesDir, String(folder ?? ''), { farmName: farmName == null ? undefined : String(farmName) })
  )

  // sync
  handle('sync:listGroups', async () => (await groups.list()).map((g) => groups.toPublic(g)))
  handle('sync:createGroup', (input: { name?: string; remote: RemoteConfig }) => serverConfig.addGroup(input))
  handle('sync:updateGroup', async (id: string, patch: { name?: string; remote?: Partial<RemoteConfig> }) => {
    const group = groups.toPublic(await groups.update(id, patch))
    // A new URL, branch or key on the active profile is used right away, not at the next start.
    if (patch.remote && (await settingsStore.get()).activeGroupId === id) void serverConfig.pullQuietly({ trigger: 'switch' })
    return group
  })
  handle('sync:removeGroup', (id: string) => groups.remove(id))
  handle('sync:gitInfo', () => findGit(true))
  handle('sync:branches', async (groupId: string) => {
    const group = await groups.get(groupId)
    const current = (group.remote.branch || 'main').trim()
    const branches = await listRemoteBranches(group.remote)
    return { current, branches, exists: branches.includes(current) }
  })
  handle('sync:localPath', async (groupId: string) => {
    const dir = groups.workDir(groupId)
    return (await exists(path.join(dir, '.git'))) ? dir : null
  })
  handle('sync:openTerminal', async (groupId: string) => {
    const dir = groups.workDir(groupId)
    if (!(await exists(path.join(dir, '.git')))) return { ok: false, error: 'This profile has not been fetched yet – pull once first.' }
    return openTerminalAt(dir)
  })
  handle('sync:state', () => serverConfig.getState())
  handle('sync:resync', () => serverConfig.pullQuietly({ trigger: 'manual' }))
  handle('sync:history', (groupId: string, limit?: number, opts?: { fetch?: boolean }) => serverConfig.history(groupId, limit, opts))

  // server config (active repository + modlist.json5)
  handle('serverConfig:view', (opts?: { fetch?: boolean }) => serverConfig.view(opts ?? {}))
  handle('serverConfig:pull', () => serverConfig.pull())
  handle('serverConfig:push', () => serverConfig.push())
  handle('serverConfig:create', () => serverConfig.create())
  handle('serverConfig:initBranch', (opts: { from: string | null }) => serverConfig.initBranch(opts ?? { from: null }))
  handle('serverConfig:setEnabled', (id: string, enabled: boolean) => serverConfig.setEnabled(id, enabled))
  handle('serverConfig:addFromCatalog', (ids: string[]) => serverConfig.addFromCatalog(ids))
  handle('serverConfig:addInstalled', (ids: string[]) => serverConfig.addInstalled(ids))
  handle('serverConfig:removeFromConfig', (id: string) => serverConfig.removeFromConfig(id))
  handle('serverConfig:revertConfigs', (ids?: string[]) => serverConfig.revertConfigs(Array.isArray(ids) ? ids.map(String) : undefined))
  handle('serverConfig:discardDraft', () => serverConfig.discardDraft())
  handle('serverConfig:revert', () => serverConfig.revert())
  handle('serverConfig:setNote', (id: string, note: string) => serverConfig.setNote(id, String(note ?? '')))
  handle('serverConfig:setName', (name: string) => serverConfig.setName(String(name ?? '')))
  handle('serverConfig:setActive', (groupId: string | null) => serverConfig.setActive(groupId))

  // activity log (what StarDöring itself is doing)
  handle('activity:list', (limit?: number) => activityLog.list(limit))
  handle('activity:openWindow', () => openActivityWindow())
  handle('activity:clear', () => activityLog.clear())
  handle('activity:file', () => activityLog.fileInfo())
  handle('activity:openFile', async () => {
    const info = await activityLog.fileInfo()
    if (!info.path) throw new Error('No log file yet.')
    if (info.exists) shell.showItemInFolder(info.path)
    else await shell.openPath(path.dirname(info.path))
  })

  // SMAPI log viewer
  handle('logs:read', (maxBytes?: number) => logs.read(maxBytes))
  handle('logs:watch', (maxBytes?: number) => logs.watch(maxBytes))
  handle('logs:unwatch', () => logs.unwatch())

  // GitHub release check (manual – one call per click against a 60/hour budget)
  handle('github:latestRelease', (repo: string) => fetchLatestGithubRelease(String(repo ?? '')))
  handle('github:install', async (req: GithubInstallRequest) => {
    await ensureDir(tempDir)
    return installFromGithub(req, {
      modsDir: game.requireModsDir(),
      tempDir,
      emit: (p: GithubInstallProgress) => broadcast('github:progress', p),
      // Anything that lands in Mods/ joins the library, like a zip install.
      afterInstall: async () => {
        await library.capture(game.requireModsDir()).catch(() => [])
      }
    })
  })

  // mod library (every downloaded version, shared by all profiles)
  handle('library:list', () => library.list())
  handle('library:install', (id: string, version: string) => library.install(String(id ?? ''), String(version ?? ''), game.requireModsDir()))
  handle('library:capture', async () => {
    const info = await game.getInfo()
    return info.modsDir ? library.capture(info.modsDir) : []
  })
  handle('library:remove', (id: string, version: string) => library.remove(String(id ?? ''), String(version ?? '')))

  // catalog
  handle('catalog:status', () => catalog.getStatus())
  handle('catalog:search', (query: string, limit?: number) => catalog.search(String(query ?? ''), limit))
  handle('catalog:top', (limit?: number) => catalog.top(limit))

  // Steam non-Steam shortcut
  handle('steam:status', () => steamShortcut.status())
  handle('steam:addShortcut', () => steamShortcut.add())

  // AppImage self-install
  handle('appimage:status', () => appimage.status())
  handle('appimage:install', async () => {
    const installed = await appimage.install()
    if (!installed.ok) return installed
    // The desktop entry has to be written from here, not after a restart: once we are running from
    // the unpacked copy there is no AppImage left to read the packaged .desktop and icons out of.
    const desktop = await appimage.installDesktopFiles()
    if (!desktop.ok) log.warn(`Installed, but the desktop entry was not written: ${desktop.message}`)
    const exec = await appimage.execPath()
    log.info(`Restarting into ${exec}`)
    relaunchInto(exec) // without the AppImage's $APPDIR, or the installed AppRun would run the old mount again
    return { ...installed, message: `${installed.message}${desktop.ok ? ' Added to the application menu.' : ''} Restarting…` }
  })
  handle('appimage:installDesktop', () => appimage.installDesktopFiles())

  // settings
  handle('settings:get', () => settingsStore.get())
  handle('settings:set', async (patch: Partial<AppSettings>) => {
    const next = await settingsStore.update(patch)
    if ('gameDirOverride' in patch || 'savesDirOverride' in patch) await game.getInfo(true)
    return next
  })

  // app
  handle('app:version', () => app.getVersion())
  handle('app:listSshKeys', () => listSshKeys())
  handle('app:quit', () => {
    app.quit()
  })
  handle('app:pickFolder', async (title?: string, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('app:pickFiles', async (opts: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const res = await dialog.showOpenDialog({ title: opts?.title, filters: opts?.filters, properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  })
  // Taken exactly once, by the renderer as it mounts: a link that arrived before there was a window.
  handle('app:takeDeepLink', () => {
    rendererReady = true
    const event = pendingDeepLink
    pendingDeepLink = null
    return event
  })
  handle('app:copyText', (text: string) => clipboard.writeText(String(text ?? '')))
  handle('app:openExternal', (url: string) => {
    if (!/^(https?|steam):/i.test(url)) throw new Error('Refusing to open non-http URL')
    return shell.openExternal(url)
  })
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
}

// Single instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv)
    if (link) handleDeepLink(link) // focuses the window itself
    else focusMainWindow()
  })
  app.whenReady().then(async () => {
    // Unpackaged macOS runs show the stock Electron dock icon unless we set ours.
    // (The menu bar and dock *name* come from the bundle – scripts/dev-app-name.cjs renames it.)
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon)
    app.setAboutPanelOptions({ applicationName: 'StarDöring', applicationVersion: app.getVersion() })
    // Windows groups taskbar entries (and their icon) by app id.
    if (process.platform === 'win32') app.setAppUserModelId('de.mimoja.stardoring')
    log.info(`StarDöring ${app.getVersion()} started on ${process.platform} (Electron ${process.versions.electron})`, { detail: `user data: ${userData}` })
    await ensureDir(tempDir)

    // The library is what is on disk; index.json only caches it. Reading it once here reconciles the
    // two at startup, so mods restored from a backup or another user-data folder show up as available
    // without waiting for someone to open the library view.
    void library
      .list()
      .then((entries) => log.debug(`Mod library ready – ${entries.length} version${entries.length === 1 ? '' : 's'}`))
      .catch((e) => log.warn(`Could not read the mod library: ${errorMessage(e)}`))

    // glibc 2.41 refuses Stardew's Galaxy libraries, which strands co-op on "Connecting to online
    // services". Checked on every start: a game update restores the originals, and this puts them back.
    void game
      .getInfo()
      .then((info) => (info.gameDir ? ensureGalaxyLibsLoadable(info.gameDir) : undefined))
      .catch((e) => log.warn(`Could not check the Galaxy libraries: ${errorMessage(e)}`))
    // Nexus nxm:// links are not handled – drop any registration that is still around.
    try {
      if (app.isDefaultProtocolClient('nxm')) app.removeAsDefaultProtocolClient('nxm')
    } catch {}
    registerIpc()
    registerProtocolClient()
    createWindow()
    // Launched by a link: it is sitting in our own argv (Windows/Linux; macOS used open-url above).
    const startupLink = deepLinkFromArgv(process.argv)
    if (startupLink) handleDeepLink(startupLink)
    process.on('uncaughtException', (e) => log.fail('Unexpected error', e))
    process.on('unhandledRejection', (e) => log.fail('Unhandled rejection', e))
    void serverConfig.pullQuietly({ trigger: 'start' }) // pull the latest server config on start (offline is fine)
    void catalog.ensure() // clone/pull the mod dataset once per start (offline is fine)
    // Take anything already installed into the library, so a fresh install of the app still offers the
    // versions this computer is running right now.
    void game.getInfo().then((i) => (i.modsDir ? library.capture(i.modsDir) : [])).catch(() => [])
    void smapiFeed.start() // merge SMAPI's log into the activity log
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

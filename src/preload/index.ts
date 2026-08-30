import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  game: {
    getInfo: (refresh) => invoke('game:getInfo', refresh),
    launch: (mode) => invoke('game:launch', mode),
    openDir: (which) => invoke('game:openDir', which),
    installSmapi: () => invoke('game:installSmapi'),
    latestSmapi: () => invoke('game:latestSmapi'),
    onExit: (cb) => on('game:exit', cb)
  },
  mods: {
    list: () => invoke('mods:list'),
    setEnabled: (folder, enabled) => invoke('mods:setEnabled', folder, enabled),
    open: (folder) => invoke('mods:open', folder),
    remove: (folder) => invoke('mods:remove', folder),
    install: (zipPaths) => invoke('mods:install', zipPaths),
    onChange: (cb) => on('mods:change', cb)
  },
  saves: {
    list: () => invoke('saves:list'),
    open: (folder) => invoke('saves:open', folder),
    duplicate: (folder, farmName) => invoke('saves:duplicate', folder, farmName)
  },
  sync: {
    listGroups: () => invoke('sync:listGroups'),
    createGroup: (input) => invoke('sync:createGroup', input),
    updateGroup: (id, patch) => invoke('sync:updateGroup', id, patch),
    removeGroup: (id) => invoke('sync:removeGroup', id),
    onProgress: (cb) => on('sync:progress', cb),
    gitInfo: () => invoke('sync:gitInfo'),
    history: (groupId, limit, opts) => invoke('sync:history', groupId, limit, opts),
    localPath: (groupId) => invoke('sync:localPath', groupId),
    branches: (groupId) => invoke('sync:branches', groupId),
    openTerminal: (groupId) => invoke('sync:openTerminal', groupId),
    state: () => invoke('sync:state'),
    onState: (cb) => on('sync:state', cb),
    resync: () => invoke('sync:resync')
  },
  serverConfig: {
    view: (opts) => invoke('serverConfig:view', opts),
    pull: () => invoke('serverConfig:pull'),
    onPull: (cb) => on('serverConfig:pull', cb),
    push: () => invoke('serverConfig:push'),
    create: () => invoke('serverConfig:create'),
    initBranch: (opts) => invoke('serverConfig:initBranch', opts),
    setEnabled: (id, enabled) => invoke('serverConfig:setEnabled', id, enabled),
    addFromCatalog: (ids) => invoke('serverConfig:addFromCatalog', ids),
    addInstalled: (ids) => invoke('serverConfig:addInstalled', ids),
    removeFromConfig: (id) => invoke('serverConfig:removeFromConfig', id),
    revertConfigs: (ids) => invoke('serverConfig:revertConfigs', ids),
    discardDraft: () => invoke('serverConfig:discardDraft'),
    revert: () => invoke('serverConfig:revert'),
    setNote: (id, note) => invoke('serverConfig:setNote', id, note),
    setName: (name) => invoke('serverConfig:setName', name),
    setActive: (groupId) => invoke('serverConfig:setActive', groupId)
  },
  github: {
    latestRelease: (repo) => invoke('github:latestRelease', repo),
    install: (req) => invoke('github:install', req),
    onProgress: (cb) => on('github:progress', cb)
  },
  library: {
    list: () => invoke('library:list'),
    install: (id, version) => invoke('library:install', id, version),
    capture: () => invoke('library:capture'),
    remove: (id, version) => invoke('library:remove', id, version)
  },
  catalog: {
    status: () => invoke('catalog:status'),
    onStatus: (cb) => on('catalog:status', cb),
    search: (query, limit) => invoke('catalog:search', query, limit),
    top: (limit) => invoke('catalog:top', limit)
  },
  activity: {
    list: (limit) => invoke('activity:list', limit),
    onEntries: (cb) => on('activity:entries', cb),
    clear: () => invoke('activity:clear'),
    file: () => invoke('activity:file'),
    openFile: () => invoke('activity:openFile'),
    openWindow: () => invoke('activity:openWindow')
  },
  logs: {
    read: (maxBytes) => invoke('logs:read', maxBytes),
    watch: (maxBytes) => invoke('logs:watch', maxBytes),
    unwatch: () => invoke('logs:unwatch'),
    onChange: (cb) => on('logs:change', cb)
  },
  steam: {
    status: () => invoke('steam:status'),
    addShortcut: () => invoke('steam:addShortcut')
  },
  appimage: {
    status: () => invoke('appimage:status'),
    install: () => invoke('appimage:install'),
    installDesktop: () => invoke('appimage:installDesktop')
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  modConfig: {
    read: (folder) => invoke('modConfig:read', folder),
    save: (folder, edits) => invoke('modConfig:save', folder, edits),
    saveText: (folder, content) => invoke('modConfig:saveText', folder, content),
    create: (folder) => invoke('modConfig:create', folder),
    reset: (folder) => invoke('modConfig:reset', folder)
  },
  app: {
    version: () => invoke('app:version'),
    platform: process.platform,
    pickFolder: (title, defaultPath) => invoke('app:pickFolder', title, defaultPath),
    pickFiles: (opts) => invoke('app:pickFiles', opts),
    openExternal: (url) => invoke('app:openExternal', url),
    copyText: (text) => invoke('app:copyText', text),
    takeDeepLink: () => invoke('app:takeDeepLink'),
    onDeepLink: (cb) => on('deeplink:open', cb),
    listSshKeys: () => invoke('app:listSshKeys'),
    quit: () => invoke('app:quit')
  }
}

contextBridge.exposeInMainWorld('api', api)

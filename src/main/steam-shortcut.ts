import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SteamShortcutStatus } from '../shared/types'
import { steamRoots } from './paths'
import { errorMessage, exists, isDir } from './util/fs'

const execFileAsync = promisify(execFile)
export const APP_NAME = 'StarDöring'

// Steam's binary VDF (shortcuts.vdf): 0x00 = map, 0x01 = string, 0x02 = int32 LE, 0x08 = end of map.

export type VdfValue = string | number | VdfMap
export interface VdfMap {
  [key: string]: VdfValue
}

export function parseBinaryVdf(buf: Buffer): VdfMap {
  let pos = 0
  const readCString = (): string => {
    const end = buf.indexOf(0, pos)
    if (end < 0) throw new Error('shortcuts.vdf: unterminated string')
    const s = buf.subarray(pos, end).toString('utf8')
    pos = end + 1
    return s
  }
  const readMap = (): VdfMap => {
    const map: VdfMap = {}
    while (pos < buf.length) {
      const type = buf[pos++]
      if (type === 0x08) return map
      const key = readCString()
      if (type === 0x00) map[key] = readMap()
      else if (type === 0x01) map[key] = readCString()
      else if (type === 0x02) {
        map[key] = buf.readInt32LE(pos)
        pos += 4
      } else throw new Error(`shortcuts.vdf: unknown field type 0x${type.toString(16)} for "${key}"`)
    }
    return map
  }
  return readMap()
}

export function serializeBinaryVdf(root: VdfMap): Buffer {
  const parts: Buffer[] = []
  const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
  const writeMap = (map: VdfMap): void => {
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === 'string') parts.push(Buffer.from([0x01]), cstr(key), cstr(value))
      else if (typeof value === 'number') {
        const b = Buffer.alloc(4)
        b.writeInt32LE(value | 0, 0)
        parts.push(Buffer.from([0x02]), cstr(key), b)
      } else {
        parts.push(Buffer.from([0x00]), cstr(key))
        writeMap(value)
      }
    }
    parts.push(Buffer.from([0x08]))
  }
  writeMap(root)
  return Buffer.concat(parts)
}

// Steam's app id for a non-Steam shortcut: crc32(exe + name) with the top bit set (stored as a signed int32).
export function shortcutAppId(exe: string, appName: string): number {
  const crc = crc32(Buffer.from(exe + appName, 'utf8'))
  return ((crc | 0x80000000) >>> 0) | 0
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

// What Steam should launch

export interface LaunchTarget {
  exe: string
  startDir: string
  launchOptions: string
}

// What Steam should start: the app bundle/exe when packaged, the Electron binary + project path in dev.
// `appImage` wins over execPath: inside an AppImage, execPath is a per-run /tmp mount that dies with the process.
/**
 * Steam preloads its overlay (gameoverlayrenderer.so) into every child of a launched game, and
 * Chromium's zygote does not survive it: the zygote child never answers its ping, every GPU process
 * fails to launch (error_code=1002) and Electron quits with "GPU process isn't usable. Goodbye." –
 * Game Mode then hangs forever on "launching executable". Clearing LD_PRELOAD for our own process
 * tree fixes it and leaves the overlay working for every other game.
 */
const LINUX_LAUNCH_OPTIONS = 'LD_PRELOAD= %command%'

export function launchTarget(opts: { isPackaged: boolean; execPath: string; appPath: string; appImage?: string | null }): LaunchTarget {
  if (opts.appImage) {
    return { exe: opts.appImage, startDir: path.dirname(opts.appImage), launchOptions: LINUX_LAUNCH_OPTIONS }
  }
  if (opts.isPackaged) {
    if (process.platform === 'darwin') {
      const idx = opts.execPath.indexOf('.app/')
      const bundle = idx > 0 ? opts.execPath.slice(0, idx + 4) : opts.execPath
      return { exe: bundle, startDir: path.dirname(bundle), launchOptions: '' }
    }
    return { exe: opts.execPath, startDir: path.dirname(opts.execPath), launchOptions: process.platform === 'linux' ? LINUX_LAUNCH_OPTIONS : '' }
  }
  return { exe: opts.execPath, startDir: opts.appPath, launchOptions: `"${opts.appPath}"` }
}

function quoted(p: string): string {
  return `"${p}"`
}

function unquote(s: string): string {
  return s.replace(/^"|"$/g, '')
}

// Accounts, running state, status, add

interface AccountConfig {
  accountId: string
  configDir: string
  shortcutsPath: string
}

async function accountConfigs(): Promise<AccountConfig[]> {
  const out: AccountConfig[] = []
  for (const root of await steamRoots()) {
    const userdata = path.join(root, 'userdata')
    if (!(await isDir(userdata))) continue
    for (const entry of await fs.readdir(userdata)) {
      if (!/^\d+$/.test(entry) || entry === '0') continue
      const configDir = path.join(userdata, entry, 'config')
      if (!(await isDir(configDir))) continue
      out.push({ accountId: entry, configDir, shortcutsPath: path.join(configDir, 'shortcuts.vdf') })
    }
  }
  return out
}

export async function isSteamRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { windowsHide: true })
      return /steam\.exe/i.test(stdout)
    }
    const name = process.platform === 'darwin' ? 'steam_osx' : 'steam'
    await execFileAsync('pgrep', ['-x', name])
    return true
  } catch {
    return false
  }
}

async function readShortcuts(p: string): Promise<VdfMap> {
  if (!(await exists(p))) return { shortcuts: {} }
  const root = parseBinaryVdf(await fs.readFile(p))
  const key = Object.keys(root).find((k) => k.toLowerCase() === 'shortcuts')
  if (!key) return { shortcuts: {} }
  return { shortcuts: root[key] as VdfMap }
}

function field(entry: VdfMap, name: string): VdfValue | undefined {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? entry[key] : undefined
}

// Our entry in a shortcuts.vdf, by name or by the executable it names.
function findOurShortcut(root: VdfMap, target: LaunchTarget): { key: string; entry: VdfMap } | null {
  const map = root.shortcuts as VdfMap
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'object') continue
    const name = String(field(value, 'AppName') ?? '')
    const exe = unquote(String(field(value, 'Exe') ?? ''))
    if (name.toLowerCase() === APP_NAME.toLowerCase() || (exe === target.exe && unquote(String(field(value, 'LaunchOptions') ?? '')) === unquote(target.launchOptions))) {
      return { key, entry: value }
    }
  }
  return null
}

// A shortcut left behind by a moved/installed AppImage points at a dead path; it must count as
// "not installed" or the UI never offers to repair it.
function isCurrent(entry: VdfMap, target: LaunchTarget): boolean {
  return (
    unquote(String(field(entry, 'Exe') ?? '')) === target.exe &&
    String(field(entry, 'LaunchOptions') ?? '') === target.launchOptions &&
    Number(field(entry, 'AllowOverlay') ?? 1) === 0
  )
}

export class SteamShortcutService {
  constructor(private readonly target: LaunchTarget) {}

  async status(): Promise<SteamShortcutStatus> {
    const accounts = await accountConfigs()
    const running = await isSteamRunning()
    if (accounts.length === 0) {
      return { steamFound: (await steamRoots()).length > 0, running, accounts: 0, installed: false, exe: this.target.exe, message: 'No Steam account data found on this computer.' }
    }
    let installedEverywhere = true
    let stale = false
    for (const a of accounts) {
      try {
        const found = findOurShortcut(await readShortcuts(a.shortcutsPath), this.target)
        if (!found) installedEverywhere = false
        else if (!isCurrent(found.entry, this.target)) {
          installedEverywhere = false
          stale = true
        }
      } catch (e) {
        return { steamFound: true, running, accounts: accounts.length, installed: false, exe: this.target.exe, message: `Could not read ${a.shortcutsPath}: ${errorMessage(e)}` }
      }
    }
    return {
      steamFound: true,
      running,
      accounts: accounts.length,
      installed: installedEverywhere,
      exe: this.target.exe,
      message: installedEverywhere
        ? `${APP_NAME} is in your Steam library as a non-Steam game.`
        : stale
          ? `The Steam entry for ${APP_NAME} points at a path that no longer exists – add it again to repair it.`
          : `${APP_NAME} is not in your Steam library yet.`
    }
  }

  // Add StarDöring as a non-Steam game for every account on this computer. Steam must be closed (it rewrites shortcuts.vdf on exit).
  async add(): Promise<{ ok: boolean; message: string }> {
    const accounts = await accountConfigs()
    if (accounts.length === 0) return { ok: false, message: 'No Steam account data found on this computer.' }
    if (await isSteamRunning()) return { ok: false, message: 'Quit Steam first – it overwrites its shortcut list when it exits – then try again.' }
    let added = 0
    for (const a of accounts) {
      const root = await readShortcuts(a.shortcutsPath)
      const found = findOurShortcut(root, this.target)
      if (found && isCurrent(found.entry, this.target)) continue
      const map = root.shortcuts as VdfMap
      // Repair the entry that is already there rather than adding a second one next to it.
      const index = found ? found.key : String(Object.keys(map).length)
      map[index] = {
        ...(found ? found.entry : {}),
        appid: shortcutAppId(quoted(this.target.exe), APP_NAME),
        AppName: APP_NAME,
        Exe: quoted(this.target.exe),
        StartDir: quoted(this.target.startDir),
        icon: '',
        ShortcutPath: '',
        LaunchOptions: this.target.launchOptions,
        IsHidden: 0,
        AllowDesktopConfig: 1,
        // Steam preloads gameoverlayrenderer.so into every app it launches with the overlay enabled,
        // and Chromium's zygote does not survive it: the child never answers, every GPU process fails
        // and Electron aborts with "GPU process isn't usable. Goodbye." before a window ever exists.
        // Clearing LD_PRELOAD from inside the process is too late – the zygote is forked before the
        // main script runs – so the injection has to be prevented here. The overlay never rendered
        // usefully over a desktop app anyway; the cost is that Steam's on-screen keyboard may not
        // reach it in Game Mode, which beats an app that cannot start.
        AllowOverlay: 0,
        OpenVR: 0,
        Devkit: 0,
        DevkitGameID: '',
        DevkitOverrideAppID: 0,
        LastPlayTime: 0,
        FlatpakAppID: '',
        tags: {}
      }
      if (await exists(a.shortcutsPath)) await fs.copyFile(a.shortcutsPath, `${a.shortcutsPath}.stardoring-backup`)
      await fs.writeFile(a.shortcutsPath, serializeBinaryVdf({ shortcuts: map }))
      added++
    }
    return { ok: true, message: added ? `${APP_NAME} was added to Steam${accounts.length > 1 ? ` (${added} account${added === 1 ? '' : 's'})` : ''}. Start Steam to see it in your library.` : `${APP_NAME} was already in your Steam library.` }
  }
}

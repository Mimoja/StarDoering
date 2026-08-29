import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GameSource, Platform } from '../shared/types'
import { isDir, isFile, readText } from './util/fs'

const execFileAsync = promisify(execFile)

export const STEAM_APP_ID = '413150'

export function currentPlatform(): Platform {
  const p = process.platform
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p
  return 'linux'
}

// Folder holding Saves/, ErrorLogs/ and startup_preferences.
export function stardewDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'StardewValley')
  }
  // macOS and Linux both use ~/.config/StardewValley (the game is built with the XDG convention)
  const xdg = process.env.XDG_CONFIG_HOME
  return path.join(xdg && process.platform === 'linux' ? xdg : path.join(os.homedir(), '.config'), 'StardewValley')
}

export function defaultSavesDir(): string {
  return path.join(stardewDataDir(), 'Saves')
}

export function smapiLogPath(dataDir: string): string {
  return path.join(dataDir, 'ErrorLogs', 'SMAPI-latest.txt')
}

async function readRegistryValue(key: string, value: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', value], { windowsHide: true })
    const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m.exec(stdout)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function steamRoots(): Promise<string[]> {
  const home = os.homedir()
  const roots: string[] = []
  switch (process.platform) {
    case 'win32': {
      const reg = await readRegistryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath')
      if (reg) roots.push(reg)
      roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam')
      break
    }
    case 'darwin':
      roots.push(path.join(home, 'Library', 'Application Support', 'Steam'))
      break
    default:
      roots.push(
        path.join(home, '.steam', 'steam'),
        path.join(home, '.steam', 'debian-installation'),
        path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
        path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
      )
  }
  const existing: string[] = []
  for (const r of roots) if (await isDir(r)) existing.push(r)
  return unique(existing)
}

// All Steam library folders (parsed from libraryfolders.vdf) across all Steam roots.
async function steamLibraries(): Promise<string[]> {
  const libs: string[] = []
  for (const root of await steamRoots()) {
    libs.push(root)
    const vdf = await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'))
    if (!vdf) continue
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      libs.push(m[1].replace(/\\\\/g, '\\'))
    }
  }
  return unique(libs)
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((p) => path.normalize(p)))]
}

// A folder is the game folder when it contains the game assembly.
export async function isGameDir(dir: string): Promise<boolean> {
  return (await isFile(path.join(dir, 'Stardew Valley.dll'))) || (await isFile(path.join(dir, 'Stardew Valley.exe')))
}

// Given any plausible user-selected folder, find the folder that actually contains the game files.
export async function resolveGameDir(input: string): Promise<string | null> {
  const variants = [
    input,
    path.join(input, 'Contents', 'MacOS'),
    path.join(input, 'Stardew Valley.app', 'Contents', 'MacOS'),
    path.join(input, 'game'),
    path.join(input, 'Stardew Valley'),
    path.join(input, 'Stardew Valley', 'Contents', 'MacOS')
  ]
  for (const v of variants) if (await isGameDir(v)) return v
  return null
}

// Enumerate every known install location for this platform and return the ones that exist.
export async function findGameCandidates(): Promise<{ path: string; source: GameSource }[]> {
  const home = os.homedir()
  const guesses: { path: string; source: GameSource }[] = []

  for (const lib of await steamLibraries()) {
    const base = path.join(lib, 'steamapps', 'common', 'Stardew Valley')
    guesses.push({ path: process.platform === 'darwin' ? path.join(base, 'Contents', 'MacOS') : base, source: 'steam' })
  }

  switch (process.platform) {
    case 'win32': {
      for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1453375253', 'HKLM\\SOFTWARE\\GOG.com\\Games\\1453375253']) {
        const p = (await readRegistryValue(key, 'path')) ?? (await readRegistryValue(key, 'PATH'))
        if (p) guesses.push({ path: p, source: 'gog' })
      }
      guesses.push(
        { path: 'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Stardew Valley', source: 'gog' },
        { path: 'C:\\Program Files\\GOG Galaxy\\Games\\Stardew Valley', source: 'gog' },
        { path: 'C:\\GOG Games\\Stardew Valley', source: 'gog' },
        { path: 'C:\\Program Files\\ModifiableWindowsApps\\Stardew Valley', source: 'xbox' },
        { path: 'C:\\XboxGames\\Stardew Valley\\Content', source: 'xbox' }
      )
      break
    }
    case 'darwin':
      guesses.push({ path: '/Applications/Stardew Valley.app/Contents/MacOS', source: 'gog' })
      break
    default:
      guesses.push(
        { path: path.join(home, 'GOG Games', 'Stardew Valley', 'game'), source: 'gog' },
        { path: path.join(home, '.local', 'share', 'GOG Games', 'Stardew Valley', 'game'), source: 'gog' },
        { path: path.join(home, 'Games', 'Stardew Valley', 'game'), source: 'gog' }
      )
  }

  const found: { path: string; source: GameSource }[] = []
  const seen = new Set<string>()
  for (const g of guesses) {
    const resolved = await resolveGameDir(g.path)
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved)
      found.push({ path: resolved, source: g.source })
    }
  }
  return found
}

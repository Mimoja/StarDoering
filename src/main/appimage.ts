import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppImageStatus } from '../shared/types'
import { PROTOCOL } from '../shared/protocol'
import { logScope } from './activity'
import { copyDir, ensureDir, errorMessage, exists, isDir, isFile, readText } from './util/fs'

const execFileAsync = promisify(execFile)
const log = logScope('app')

/**
 * An AppImage runs from wherever it was downloaded to, and its /tmp mount changes on every start, so
 * nothing outside the process may point at the running binary. "Install to home" therefore unpacks it
 * to a fixed folder; "Install desktop files" registers that folder with the desktop.
 *
 * It unpacks rather than copies because Chromium cannot run from the AppImage's FUSE mount when Steam
 * launches it: every child process fails to allocate shared memory ("Creating shared memory in
 * /dev/shm/… failed: No such process"), the renderer is disposed before it paints, and Steam Deck
 * Game Mode hangs on "launching executable" forever. From an unpacked tree the same build runs with
 * the sandbox on and no special flags at all.
 */

// Fixed, ASCII: this path ends up in shortcut fields, desktop entries and shell commands.
const DIR_NAME = 'StarDoering'

// Matches package.json desktopName, so the entry, the icon and Electron's app_id agree.
const DESKTOP_NAME = 'stardoering.desktop'
const ICON_NAME = 'stardoering'

// Where an installed AppImage goes: ~/Applications (the AppImageLauncher convention, and what SteamOS ships),
// else ~/.bin.
export async function installDir(): Promise<string> {
  const home = os.homedir()
  const applications = path.join(home, 'Applications')
  if (process.platform === 'linux' && (await isDir(applications))) return applications
  return path.join(home, '.bin')
}

/** The unpacked install folder. */
export async function installPath(): Promise<string> {
  return path.join(await installDir(), DIR_NAME)
}

/** The launcher inside it – what a shortcut or a .desktop entry runs. */
export async function execPath(): Promise<string> {
  return path.join(await installPath(), 'AppRun')
}

/**
 * The AppImage file we are running from, or null. The runtime exports $APPIMAGE – the file itself
 * rather than the /tmp mount – for exactly this purpose.
 *
 * The catch: electron-builder's AppRun sets `APPIMAGE="$APPDIR/AppRun"` when there is no AppImage,
 * so an unpacked install claims to be one. Taking that at face value made "Install to home" delete
 * the tree it was running from and then hang. A real AppImage is a file called something else.
 */
export function runningAppImage(): string | null {
  const p = process.env['APPIMAGE']
  if (!p || !path.isAbsolute(p)) return null
  if (path.basename(p) === 'AppRun') return null
  const dir = process.env['APPDIR']
  if (dir && path.resolve(p).startsWith(path.resolve(dir) + path.sep)) return null
  return p
}

/**
 * What a Steam shortcut should start: the unpacked install when there is one, else the running
 * AppImage, else null. Sync because the Steam service is built before the first await.
 */
export function steamExecPath(): string | null {
  const home = os.homedir()
  const dir = process.platform === 'linux' && existsSync(path.join(home, 'Applications')) ? path.join(home, 'Applications') : path.join(home, '.bin')
  const installed = path.join(dir, DIR_NAME, 'AppRun')
  if (existsSync(installed)) return installed
  return runningAppImage()
}

/**
 * The folder holding our own .desktop file and icons: the AppImage's mounted AppDir, or the unpacked
 * install we are running from. $APPDIR is only set by the AppImage runtime, so for an unpacked tree
 * we recognise it by the AppRun sitting next to the executable.
 */
function appDir(): string | null {
  const env = process.env['APPDIR']
  if (env && path.isAbsolute(env)) return env
  const beside = path.dirname(process.execPath)
  return existsSync(path.join(beside, 'AppRun')) ? beside : null
}

// $XDG_DATA_HOME, or the ~/.local/share it defaults to.
function dataHome(): string {
  const xdg = process.env['XDG_DATA_HOME']
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share')
}

export function desktopFilePath(): string {
  return path.join(dataHome(), 'applications', DESKTOP_NAME)
}

export async function status(): Promise<AppImageStatus> {
  const source = runningAppImage()
  const target = await installPath()
  const desktopFile = desktopFilePath()
  const dir = appDir()
  return {
    running: source != null,
    source,
    target,
    installed: await isFile(await execPath()),
    // Running from the unpacked install already – there is nothing left to install.
    current: dir != null && path.resolve(dir) === path.resolve(target),
    desktopFile,
    desktopInstalled: await isFile(desktopFile)
  }
}

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const

/**
 * Free a path that holds an install tree.
 *
 * Renaming it out of the way first is what makes this reliable: a directory rename succeeds even
 * when something inside cannot be unlinked yet – a copy still shutting down, an app.asar the kernel
 * still has mapped – whereas deleting in place fails on that one file and takes the whole update
 * with it. Once renamed the path is free, so the install can go ahead; clearing the leftovers is
 * best-effort and never fatal.
 *
 * The recursive rm itself also walks in parallel and can reach rmdir while a child is still going
 * away, which on a tree this size throws ENOTEMPTY – hence the retries.
 */
async function removeInstall(dir: string): Promise<void> {
  if (!(await exists(dir))) return
  const doomed = `${dir}.deleting-${process.pid}`
  try {
    await fs.rename(dir, doomed)
  } catch (e) {
    log.debug(`Could not rename ${dir} aside, deleting in place`, { detail: e instanceof Error ? e.message : String(e) })
    await fs.rm(dir, RM)
    return
  }
  await fs.rm(doomed, RM).catch((e) => log.warn(`Left ${doomed} behind – it can be deleted by hand`, { detail: errorMessage(e) }))
}

/** Tidy up trees a previous update could not finish deleting. */
async function sweepLeftovers(parent: string): Promise<void> {
  for (const name of await fs.readdir(parent).catch(() => [] as string[])) {
    if (!name.startsWith(`${DIR_NAME}.deleting-`)) continue
    await fs.rm(path.join(parent, name), RM).catch(() => undefined)
  }
}

export async function install(): Promise<{ ok: boolean; message: string; path: string }> {
  const source = runningAppImage()
  const target = await installPath()
  if (!source) {
    return { ok: false, message: 'StarDöring is not running as an AppImage, so there is nothing to install.', path: target }
  }
  if (!(await isFile(source))) {
    return { ok: false, message: `The running AppImage is gone: ${source}`, path: target }
  }
  // Never delete the tree we are executing from, whatever $APPIMAGE claims.
  const resolved = path.resolve(target)
  if (path.resolve(source) === resolved || path.resolve(process.execPath).startsWith(resolved + path.sep)) {
    return { ok: true, message: `Already running from ${target} – nothing to install.`, path: target }
  }
  const parent = path.dirname(target)
  if ((await exists(parent)) && !(await isDir(parent))) {
    return { ok: false, message: `${parent} exists but is not a folder.`, path: target }
  }
  await ensureDir(parent)
  const started = Date.now()
  const since = (): string => `${Date.now() - started} ms`
  log.info(`Installing into ${target}`, { detail: `from ${source} (${(await fs.stat(source)).size} bytes)` })

  // --appimage-extract always writes ./squashfs-root, so unpack in a scratch folder and move the
  // result into place. The old install is deleted first: swapping it aside and cleaning up afterwards
  // was two more chances to fail on a tree this size, and re-running from the AppImage is cheap.
  const scratch = path.join(parent, `.${DIR_NAME}-unpack`)
  log.debug(`Clearing ${scratch} and the previous install at ${target}`)
  await sweepLeftovers(parent)
  await removeInstall(scratch)
  await removeInstall(target)
  await ensureDir(scratch)
  try {
    // ELECTRON_RUN_AS_NODE must not reach the child: the AppImage would start as Node and sit there
    // instead of unpacking, and the install would hang until the timeout.
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    log.info('Unpacking the AppImage – this takes a while', { detail: `${source} --appimage-extract (cwd ${scratch}, 5 min limit)` })
    const { stdout, stderr } = await execFileAsync(source, ['--appimage-extract'], { cwd: scratch, env, timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 })
    log.debug(`Unpacked in ${since()}`, { detail: `${stdout.length + stderr.length} bytes of output${stderr.trim() ? `\n${stderr.trim().slice(-2000)}` : ''}` })

    const unpacked = path.join(scratch, 'squashfs-root')
    if (!(await isFile(path.join(unpacked, 'AppRun')))) {
      log.fail('The AppImage unpacked without an AppRun launcher', new Error(`no AppRun in ${unpacked}`))
      return { ok: false, message: 'The AppImage unpacked without an AppRun launcher.', path: target }
    }
    await fs.chmod(path.join(unpacked, 'AppRun'), 0o755)
    log.debug(`Moving the new install into place: ${unpacked} → ${target}`)
    await fs.rename(unpacked, target)
  } catch (e) {
    log.fail(`Installing failed after ${since()}`, e)
    throw e
  } finally {
    await removeInstall(scratch).catch((e) => log.warn(`Could not remove ${scratch}`, { detail: errorMessage(e) }))
  }
  log.info(`Installed to ${target} in ${since()}`)
  return { ok: true, message: `Installed to ${target}.`, path: target }
}

// Desktop entry + icons

// Set (or add) one `Key=value` in the [Desktop Entry] section.
function setEntry(text: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(text)) return text.replace(re, line)
  return `${text.replace(/\n*$/, '')}\n${line}\n`
}

// The AppImage's own .desktop file, so the menu entry keeps the packaged name and categories.
async function readAppDirDesktop(dir: string): Promise<string | null> {
  const preferred = path.join(dir, DESKTOP_NAME)
  if (await isFile(preferred)) return readText(preferred)
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.desktop')) return readText(path.join(dir, name))
  }
  return null
}

// Copy the icons out of the AppDir into the user's icon theme: the AppDir mount is ephemeral, so an `Icon=`
// pointing into it would break on the next start.
async function installIcons(dir: string): Promise<number> {
  const themeDir = path.join(dataHome(), 'icons', 'hicolor')
  const packed = path.join(dir, 'usr', 'share', 'icons', 'hicolor')
  if (await isDir(packed)) {
    await ensureDir(themeDir)
    await copyDir(packed, themeDir)
    return (await fs.readdir(packed).catch(() => [] as string[])).length
  }
  // No icon theme in the AppDir – fall back to the top-level icon the AppImage runtime uses.
  for (const candidate of [`${ICON_NAME}.png`, '.DirIcon']) {
    const file = path.join(dir, candidate)
    if (!(await isFile(file))) continue
    const dest = path.join(themeDir, '512x512', 'apps', `${ICON_NAME}.png`)
    await ensureDir(path.dirname(dest))
    await fs.copyFile(file, dest)
    return 1
  }
  return 0
}

// Best-effort cache refresh; both tools are optional and their absence is not an error.
async function refreshCaches(): Promise<void> {
  const applications = path.join(dataHome(), 'applications')
  await execFileAsync('update-desktop-database', [applications]).catch(() => undefined)
  await execFileAsync('gtk-update-icon-cache', ['-tq', path.join(dataHome(), 'icons', 'hicolor')]).catch(() => undefined)
  // Makes stardoering:// links from a browser or a chat client open this entry.
  await execFileAsync('xdg-mime', ['default', DESKTOP_NAME, `x-scheme-handler/${PROTOCOL}`]).catch(() => undefined)
}

// Write the .desktop entry (and icons) into ~/.local/share, pointing at the installed AppImage when there is
// one and at the running file otherwise.
export async function installDesktopFiles(): Promise<{ ok: boolean; message: string; path: string }> {
  const file = desktopFilePath()
  if (process.platform !== 'linux') {
    return { ok: false, message: 'Desktop entries are a Linux thing.', path: file }
  }
  const dir = appDir()
  if (!dir) {
    return { ok: false, message: 'StarDöring is not running from an AppImage or an unpacked install, so there is no desktop entry to write.', path: file }
  }
  const installed = await execPath()
  // Prefer the stable install: an entry pointing into ~/Downloads breaks as soon as it is cleaned out.
  const exec = (await isFile(installed)) ? installed : (runningAppImage() ?? path.join(dir, 'AppRun'))

  const packaged = await readAppDirDesktop(dir)
  let entry =
    packaged ??
    ['[Desktop Entry]', 'Type=Application', 'Name=StarDöring', 'Comment=Stardew Valley launcher & mod manager', 'Terminal=false', 'Categories=Game;', `StartupWMClass=${ICON_NAME}`, ''].join('\n')

  entry = setEntry(entry, 'Exec', `"${exec}" %U`)
  entry = setEntry(entry, 'TryExec', exec)
  entry = setEntry(entry, 'Icon', ICON_NAME)
  // Without this the stardoering:// link on the download page has nothing to open.
  entry = setEntry(entry, 'MimeType', `x-scheme-handler/${PROTOCOL};`)
  // X-AppImage-Version describes the AppDir, not an installed entry, and only confuses updaters.
  entry = entry.replace(/^X-AppImage-Version=.*$\n?/m, '')

  log.info(`Writing the desktop entry ${file}`, { detail: `Exec="${exec}" %U` })
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, entry, { mode: 0o644 })

  const icons = await installIcons(dir)
  log.debug(`Installed ${icons} icon size${icons === 1 ? '' : 's'} from ${dir}`)
  // update-desktop-database and friends are optional and can be slow on a cold cache.
  await refreshCaches()

  const where = exec === installed ? 'the installed copy' : 'the AppImage you started'
  return {
    ok: true,
    message: `Registered in the application menu, pointing at ${where}${icons ? '' : ' (no icon found in the AppImage)'}.`,
    path: file
  }
}

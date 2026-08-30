import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'
import { logScope } from './activity'

const log = logScope('app')

// Set by the AppImage runtime (and the portable-exe stub) for their child. Handed on to a replacement, AppRun
// trusts the inherited $APPDIR and starts the old mount again, and the app believes it is still the AppImage.
const LAUNCHER_VARS = ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0', 'APPIMAGE_EXTRACT_AND_RUN', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'ELECTRON_RUN_AS_NODE']
// AppRun prepends $APPDIR to these; entries under a dead mount only get in the way.
const SEARCH_PATHS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

// The environment a replacement process starts with: ours, minus what the launcher of this one set up.
export function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const appDir = env['APPDIR']?.replace(/\/+$/, '')
  for (const k of LAUNCHER_VARS) delete env[k]
  if (appDir) {
    for (const k of SEARCH_PATHS) {
      const v = env[k]
      if (v) env[k] = v.split(':').filter((p) => p !== appDir && !p.startsWith(`${appDir}/`)).join(':')
    }
  }
  return env
}

export interface RelaunchOptions {
  args?: string[]
  // Windows only: a file to delete once this process is gone (the portable exe that was replaced).
  remove?: string
}

// Start `target` once this process is gone, then exit. Not app.relaunch(): that makes the replacement our
// child, which meets our own single-instance lock and dies with our process group when Steam started us.
export function relaunchInto(target: string, opts: RelaunchOptions = {}): void {
  const args = opts.args ?? []
  setTimeout(() => {
    try {
      const child = process.platform === 'win32' ? spawnWindows(target, args, opts.remove) : spawnPosix(target, args)
      child.unref()
    } catch (e) {
      log.fail(`Could not start ${target} – start it by hand`, e)
    }
    app.exit(0)
  }, 800)
}

// A detached shell waits for our pid (the lock is free then) and execs the target – or opens the bundle on macOS.
// The path travels as $0 and needs no quoting.
function spawnPosix(target: string, args: string[]): ChildProcess {
  const wait = 'n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n+1)); done; shift; '
  const run = process.platform === 'darwin' && target.endsWith('.app') ? `exec open "$0"${args.length ? ' --args "$@"' : ''}` : 'exec "$0" "$@"'
  return spawn('/bin/sh', ['-c', wait + run, target, String(process.pid), ...args], { detached: true, stdio: 'ignore', env: launchEnv() })
}

// No pid wait in cmd: a few pings are the classic sleep, long enough for the app and a portable stub to go away.
// Switches stay bare – NSIS only recognises an unquoted /S.
function spawnWindows(target: string, args: string[], remove?: string): ChildProcess {
  const steps = ['ping -n 4 127.0.0.1 >nul']
  if (remove && path.resolve(remove) !== path.resolve(target)) steps.push(`del /q "${remove}"`)
  steps.push(`start "" "${target}" ${args.join(' ')}`.trimEnd())
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${steps.join(' & ')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: launchEnv() })
}

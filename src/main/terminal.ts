import { spawn } from 'node:child_process'
import { isDir } from './util/fs'

// Open a terminal window in `dir`. Arguments go as argv arrays, never shell-interpolated (paths with spaces
// or umlauts are normal here). Returns ok:false with a readable message instead of throwing.
export async function openTerminalAt(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isDir(dir))) return { ok: false, error: `Folder does not exist: ${dir}` }
  const candidates = terminalCandidates(dir)
  for (const c of candidates) {
    if (c.check && !(await c.check())) continue
    const ok = await trySpawn(c.cmd, c.args)
    if (ok) return { ok: true }
  }
  return { ok: false, error: 'No terminal application found. Set the TERMINAL environment variable to your terminal emulator.' }
}

interface Candidate {
  cmd: string
  args: string[]
  check?: () => Promise<boolean>
}

function terminalCandidates(dir: string): Candidate[] {
  switch (process.platform) {
    case 'darwin':
      return [
        { cmd: 'open', args: ['-b', 'com.apple.Terminal', dir] },
        { cmd: 'open', args: ['-a', 'Terminal', dir] }
      ]
    case 'win32':
      return [
        { cmd: 'wt', args: ['-d', dir] },
        { cmd: 'cmd', args: ['/c', 'start', '"StarDöring"', 'cmd', '/K', 'cd', '/d', dir] }
      ]
    default: {
      const list: Candidate[] = []
      const custom = process.env['TERMINAL']
      if (custom) list.push({ cmd: custom, args: [], check: async () => true })
      list.push(
        { cmd: 'x-terminal-emulator', args: [] },
        { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] },
        { cmd: 'konsole', args: ['--workdir', dir] },
        { cmd: 'xfce4-terminal', args: [`--working-directory=${dir}`] },
        { cmd: 'alacritty', args: ['--working-directory', dir] },
        { cmd: 'kitty', args: ['-d', dir] },
        { cmd: 'xterm', args: ['-e', 'sh', '-c', 'cd "$0" && exec "${SHELL:-sh}"', dir] }
      )
      return list
    }
  }
}

// Spawn detached; resolves true when the process started (i.e. the binary exists).
function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false })
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

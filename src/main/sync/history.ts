import path from 'node:path'
import type { SyncCommit } from '../../shared/types'
import { exists } from '../util/fs'
import { runGit } from './git'

const RS = '\x1e' // record separator between commits
const FS = '\x1f' // field separator inside the header line
const BE = '\x1d' // end of the commit body

// Commit history of a local clone via `git log` – no network, [] when there are no commits yet.
export async function readHistory(dir: string, limit = 30): Promise<SyncCommit[]> {
  if (!(await exists(path.join(dir, '.git')))) return []
  let out: string
  try {
    out = (await runGit(['log', `-n${Math.max(1, Math.min(limit, 500))}`, `--format=${RS}%h${FS}%s${FS}%an${FS}%at${FS}%b${BE}`, '--name-only', '--no-color'], { cwd: dir, timeoutMs: 30_000, quiet: true })).stdout
  } catch {
    return []
  }
  let head = ''
  try {
    head = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir, timeoutMs: 10_000, quiet: true })).stdout.trim()
  } catch {
    // unborn branch
  }

  const commits: SyncCommit[] = []
  for (const record of out.split(RS)) {
    const bodyEnd = record.indexOf(BE)
    if (bodyEnd < 0) continue
    const [hash, subject, author, at, body = ''] = record.slice(0, bodyEnd).split(FS)
    if (!hash) continue
    const details = body.split('\n').map((l) => l.trim()).filter(Boolean)
    const files = record.slice(bodyEnd + 1).split('\n').map((l) => l.trim()).filter(Boolean)
    const mods = new Set<string>()
    for (const f of files) {
      const m = /^mods\/([^/]+)\//.exec(f)
      if (m) mods.add(m[1].replace(/^\.+/, ''))
    }
    commits.push({ hash, subject, author, at: Number(at) * 1000, filesChanged: files.length, modsChanged: [...mods].slice(0, 8), current: hash === head, details })
  }
  return commits
}

import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import JSON5 from 'json5'

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

// Read a UTF-8 text file; returns null when it does not exist.
export async function readText(p: string): Promise<string | null> {
  try {
    return stripBom(await fs.readFile(p, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// SMAPI accepts comments and trailing commas in manifest/config files – so do we.
export function parseLenientJson<T = unknown>(text: string): T {
  return JSON5.parse(stripBom(text)) as T
}

export async function readJsonLenient<T = unknown>(p: string): Promise<T | null> {
  const text = await readText(p)
  if (text == null) return null
  return parseLenientJson<T>(text)
}

// Strict JSON read with a fallback for missing/corrupt files.
export async function readJson<T>(p: string, fallback: T): Promise<T> {
  const text = await readText(p)
  if (text == null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

// Write to a temp file in the same directory, then rename – never leaves a half-written file behind.
export async function writeFileAtomic(p: string, data: Buffer | string): Promise<void> {
  await ensureDir(path.dirname(p))
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, p)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await writeFileAtomic(p, JSON.stringify(data, null, 2))
}

export interface WalkEntry {
  abs: string
  // Relative to the walk root, forward slashes.
  rel: string
  size: number
}

export interface WalkOptions {
  // Return true to skip a file or directory (directories are not descended into).
  skip?: (rel: string, entry: Dirent) => boolean
}

// Recursively list regular files under `root`. Symlinks are ignored.
export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  async function visit(dir: string, relBase: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (opts.skip?.(rel, entry)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(abs, rel)
      } else if (entry.isFile()) {
        // Between the readdir above and this stat the file can be gone – a mod rewriting its config.json,
        // a reset moving it to the trash. A vanished file is not a reason to fail the whole walk.
        try {
          const st = await fs.stat(abs)
          out.push({ abs, rel, size: st.size })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
    }
  }
  await visit(root, '')
  return out
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, force: true })
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

// Join a relative (possibly untrusted) path onto a root, refusing traversal outside of it.
export function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...rel.split('/'))
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to access path outside of ${root}: ${rel}`)
  }
  return target
}

export async function dirStats(dir: string): Promise<{ sizeBytes: number; fileCount: number }> {
  const entries = await walk(dir)
  return { sizeBytes: entries.reduce((n, e) => n + e.size, 0), fileCount: entries.length }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

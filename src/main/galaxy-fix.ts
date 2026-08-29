import { promises as fs } from 'node:fs'
import path from 'node:path'
import { logScope } from './activity'
import { exists, isFile } from './util/fs'

const log = logScope('game')

/**
 * Stardew Valley ships two GOG Galaxy libraries built in 2023 with an executable-stack marker
 * (`GNU_STACK: RWE`). glibc 2.41 stopped honouring that, so the loader refuses them and the game
 * reports "Error initializing the Galaxy API" – which leaves co-op stuck on "Connecting to online
 * services" forever, LAN included, no matter whether Steam or we started the game.
 *
 * The community fix is `patchelf --clear-execstack` (or `execstack -c`), neither of which ships with
 * SteamOS. Both do the same one-byte edit we do here: clear the executable bit of the PT_GNU_STACK
 * program header. The originals are kept next to the files, and a game update or Steam's "verify
 * integrity" restores them – in which case the next start patches them again.
 *
 * See https://forums.stardewvalley.net/threads/galaxy-api-not-loading-with-glibc-2-41.36974/
 */

const GALAXY_LIBS = ['libGalaxy64.so', 'libGalaxyCSharpGlue.so']
const BACKUP_SUFFIX = '.execstack-backup'

const PT_GNU_STACK = 0x6474e551
const PF_X = 0x1

interface StackHeader {
  /** File offset of the p_flags field of the PT_GNU_STACK entry. */
  flagsOffset: number
  flags: number
}

/**
 * Locate the PT_GNU_STACK program header of a 64-bit little-endian ELF. Returns null for anything
 * else – we only ever see x86_64 here, and guessing at other layouts would corrupt the file.
 */
async function readStackHeader(file: string): Promise<StackHeader | null> {
  const fh = await fs.open(file, 'r')
  try {
    const ident = Buffer.alloc(64)
    const { bytesRead } = await fh.read(ident, 0, 64, 0)
    if (bytesRead < 64) return null
    if (ident.toString('latin1', 0, 4) !== '\x7fELF') return null
    if (ident[4] !== 2 || ident[5] !== 1) return null // 64-bit, little endian only

    const phoff = Number(ident.readBigUInt64LE(0x20))
    const phentsize = ident.readUInt16LE(0x36)
    const phnum = ident.readUInt16LE(0x38)
    if (!phoff || !phentsize || !phnum) return null

    const table = Buffer.alloc(phentsize * phnum)
    await fh.read(table, 0, table.length, phoff)
    for (let i = 0; i < phnum; i++) {
      const at = i * phentsize
      if (table.readUInt32LE(at) !== PT_GNU_STACK) continue
      return { flagsOffset: phoff + at + 4, flags: table.readUInt32LE(at + 4) }
    }
    return null
  } finally {
    await fh.close()
  }
}

/** Clear the executable bit in place – the same edit `patchelf --clear-execstack` makes. */
async function clearExecStack(file: string, header: StackHeader): Promise<void> {
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!(await exists(backup))) await fs.copyFile(file, backup)
  const fh = await fs.open(file, 'r+')
  try {
    const flags = Buffer.alloc(4)
    flags.writeUInt32LE(header.flags & ~PF_X, 0)
    await fh.write(flags, 0, 4, header.flagsOffset)
  } finally {
    await fh.close()
  }
}

/**
 * Patch the Galaxy libraries in `gameDir` if they still ask for an executable stack. Safe to call on
 * every start: libraries that are already clear are left alone, and any failure is logged rather
 * than thrown – a game that cannot do co-op is still a game that should start.
 */
export async function ensureGalaxyLibsLoadable(gameDir: string): Promise<{ patched: string[]; failed: string[] }> {
  const patched: string[] = []
  const failed: string[] = []
  if (process.platform !== 'linux') return { patched, failed }

  for (const name of GALAXY_LIBS) {
    const file = path.join(gameDir, name)
    try {
      if (!(await isFile(file))) continue
      const header = await readStackHeader(file)
      if (!header || (header.flags & PF_X) === 0) continue // already loadable
      await clearExecStack(file, header)
      patched.push(name)
    } catch (e) {
      failed.push(name)
      log.warn(`Could not clear the executable-stack flag on ${name}`, { detail: e instanceof Error ? e.message : String(e) })
    }
  }

  if (patched.length) {
    log.info(`Repaired ${patched.join(' and ')} so Stardew Valley can reach the online services`, {
      detail: `glibc 2.41 refuses to load these with an executable stack; the originals are kept as *${BACKUP_SUFFIX}`
    })
  }
  return { patched, failed }
}

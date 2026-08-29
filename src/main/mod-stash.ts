import { promises as fs } from 'node:fs'
import path from 'node:path'
import { scanMods } from './mods'
import { ensureDir, exists, isDir } from './util/fs'
import { logScope } from './activity'

const log = logScope('mods')

/**
 * Mods/ belongs to whichever profile is active. Anything installed by hand would otherwise bleed
 * into the next profile's list, so switching parks the whole folder and restores what the profile
 * being switched to had last time. Mod folders move whole, so each mod's config.json travels with it
 * and comes back exactly as it was.
 *
 * The park lives next to Mods/ inside the game folder rather than in userData, so moving a mod set
 * is a rename on the same filesystem – instant, even for the gigabytes a heavy profile can hold.
 * SMAPI's own mods stay where they are: they belong to the game, never to a profile, and the rest of
 * the app already refuses to put them in a config.
 *
 * Everything here is built so that a crash, a race or a bug cannot leave a profile's mods nowhere:
 * the new park is assembled under a temporary name and only swapped in once it is complete, the
 * previous park is removed after that swap rather than before it, and removals go to the trash.
 */
const STASH_DIR = '.stardoering-profiles'

/** Mods that were in place while no profile was selected still have to come back. */
const NO_PROFILE = '_no-profile'

/** Switches are serialised: two interleaving swaps could park one profile's mods over another's. */
let queue: Promise<unknown> = Promise.resolve()

export function stashRoot(gameDir: string): string {
  return path.join(gameDir, STASH_DIR)
}

function stashFor(gameDir: string, groupId: string | null): string {
  // Group ids are generated, but a stray path separator would escape the stash folder.
  const key = (groupId ?? NO_PROFILE).replace(/[^\w.-]/g, '_')
  return path.join(stashRoot(gameDir), key)
}

/** Top-level entries of Mods/ that belong to the profile – everything except SMAPI's own mods. */
async function profileEntries(modsDir: string): Promise<string[]> {
  if (!(await isDir(modsDir))) return []
  const bundled = new Set<string>()
  for (const mod of await scanMods(modsDir)) {
    if (mod.isBundled) bundled.add(mod.folder.split('/')[0].toLowerCase())
  }
  const entries = await fs.readdir(modsDir).catch(() => [] as string[])
  return entries.filter((name) => !bundled.has(name.toLowerCase()))
}

/** Rename when we can, copy when the stash and Mods/ turn out to be on different filesystems. */
async function move(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to))
  try {
    await fs.rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fs.cp(from, to, { recursive: true, force: true })
    await fs.rm(from, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

export interface StashOptions {
  /** Move to the OS trash instead of deleting, so a mistake here stays recoverable. */
  trash?: (absPath: string) => Promise<void>
}

async function discard(target: string, opts: StashOptions): Promise<void> {
  if (!(await exists(target))) return
  if (opts.trash) {
    try {
      await opts.trash(target)
      return
    } catch (e) {
      log.warn(`Could not move ${target} to the trash, deleting instead`, { detail: e instanceof Error ? e.message : String(e) })
    }
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

async function swap(gameDir: string, modsDir: string, from: string | null, to: string | null, opts: StashOptions): Promise<{ stashed: number; restored: number }> {
  const parked = stashFor(gameDir, from)
  const incoming = stashFor(gameDir, to)
  const staging = `${parked}.staging`

  // 1. Assemble the new park under a name of its own. Until it is complete, the old one is untouched.
  await discard(staging, opts)
  const leaving = await profileEntries(modsDir)
  for (const name of leaving) await move(path.join(modsDir, name), path.join(staging, name))

  // 2. Swap it in. An empty Mods/ never replaces a park that has something in it: a profile whose
  //    mods are already parked can be left again (a double switch, an interrupted pull) and that must
  //    not be what erases them.
  if (leaving.length > 0) {
    await discard(parked, opts)
    await move(staging, parked)
  } else if (await isDir(parked)) {
    log.warn(`Mods/ was empty, keeping the ${leaving.length ? '' : 'existing '}park at ${parked}`)
    await discard(staging, opts)
  } else if (await exists(staging)) {
    await move(staging, parked)
  }

  // 3. Restore the incoming profile. A folder the pull already put in place loses to the parked one:
  //    the park is what the user last had, the repository copy can always be fetched again.
  let restored = 0
  if (await isDir(incoming)) {
    for (const name of await fs.readdir(incoming)) {
      const dest = path.join(modsDir, name)
      if (await exists(dest)) await discard(dest, opts)
      await move(path.join(incoming, name), dest)
      restored++
    }
    await fs.rmdir(incoming).catch(() => undefined) // empty now; leaving it would look like a profile with no mods
  }

  log.info('Swapped the mod folder for the new profile', {
    detail: `parked ${leaving.length} folder${leaving.length === 1 ? '' : 's'} in ${parked}, restored ${restored} from ${incoming}`
  })
  return { stashed: leaving.length, restored }
}

/**
 * Park the mods of `from` and restore those of `to`. Returns how many top-level folders moved each
 * way. Calls are serialised, so a second switch waits for the first rather than racing it.
 */
export function switchProfileMods(
  gameDir: string,
  modsDir: string,
  from: string | null,
  to: string | null,
  opts: StashOptions = {}
): Promise<{ stashed: number; restored: number }> {
  const run = queue.then(() => swap(gameDir, modsDir, from, to, opts))
  // Keep the chain alive even when this switch fails, or every later switch would reject with it.
  queue = run.catch(() => undefined)
  return run
}

// SMAPI's own mods (ConsoleCommands, SaveBackup, ErrorHandler) are listed for completeness but never enter
// modlist.json5 or mods/. Synthetic Mods folder + local bare repository, no network: npm run smoke:bundled
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { AppSettings, ServerConfigView } from '../src/shared/types'
import { ServerConfigService } from '../src/main/server-config'
import { CatalogService } from '../src/main/catalog'
import { GroupStore } from '../src/main/sync/groups'
import { JsonStore, plainCodec } from '../src/main/store'
import { ModlistService } from '../src/main/modlist/service'
import type { GameService } from '../src/main/game'
import { scanMods } from '../src/main/mods'

interface Fixture {
  folder: string
  uniqueId: string
  name: string
  version: string
}

// Three mods of the user's plus the three SMAPI ships with.
const USER_MODS: Fixture[] = [
  { folder: 'Automate', uniqueId: 'Pathoschild.Automate', name: 'Automate', version: '2.6.1' },
  { folder: 'ContentPatcher', uniqueId: 'Pathoschild.ContentPatcher', name: 'Content Patcher', version: '2.9.1' },
  { folder: 'LookupAnything', uniqueId: 'Pathoschild.LookupAnything', name: 'Lookup Anything', version: '1.55.0' }
]
const BUNDLED_MODS: Fixture[] = [
  { folder: 'ConsoleCommands', uniqueId: 'SMAPI.ConsoleCommands', name: 'Console Commands', version: '4.5.2' },
  { folder: 'SaveBackup', uniqueId: 'SMAPI.SaveBackup', name: 'Save Backup', version: '4.5.2' },
  { folder: 'ErrorHandler', uniqueId: 'SMAPI.ErrorHandler', name: 'Error Handler', version: '4.5.2' }
]

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
  console.log(`  ok · ${what}`)
}

async function writeMod(modsDir: string, m: Fixture): Promise<void> {
  const dir = path.join(modsDir, m.folder)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ Name: m.name, Author: 'smoke', Version: m.version, Description: m.name, UniqueID: m.uniqueId, EntryDll: `${m.folder}.dll` }, null, 2))
  await fs.writeFile(path.join(dir, `${m.folder}.dll`), `binary of ${m.name}`)
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), 'stardoring-smoke-bundled')
  await fs.rm(root, { recursive: true, force: true })
  const userData = path.join(root, 'userData')
  const gameDir = path.join(root, 'game')
  const modsDir = path.join(gameDir, 'Mods')
  const tmp = path.join(root, 'tmp')
  for (const d of [userData, modsDir, tmp]) await fs.mkdir(d, { recursive: true })
  for (const m of [...USER_MODS, ...BUNDLED_MODS]) await writeMod(modsDir, m)

  const total = USER_MODS.length + BUNDLED_MODS.length
  const installed = await scanMods(modsDir)
  console.log(`1) scan: ${installed.length} mods, ${installed.filter((m) => m.isBundled).length} of them shipped with SMAPI`)
  check(installed.length === total, `scanMods sees all ${total} mods`)
  check(installed.filter((m) => m.isBundled).length === BUNDLED_MODS.length, `${BUNDLED_MODS.length} are recognised as SMAPI built-ins`)

  const fakeGame = {
    getInfo: async () => ({
      platform: process.platform,
      found: true,
      gameDir,
      gameVersion: '1.6.15',
      source: 'manual',
      candidates: [],
      smapi: { installed: true, version: '4.5.2', launcherPath: null },
      dataDir: '',
      savesDir: '',
      savesDirExists: false,
      modsDir,
      smapiLogPath: null,
      lastRun: null,
      running: false
    }),
    requireModsDir: () => modsDir,
    requireGameDir: () => gameDir
  } as unknown as GameService

  const settings = new JsonStore<AppSettings>(path.join(userData, 'settings.json'), () => ({ gameDirOverride: null, savesDirOverride: null, activeGroupId: null, localModsOnly: false, authorName: 'StarDöring smoke', authorEmail: 'smoke@stardoring.local' }))
  const groups = new GroupStore(userData, plainCodec)
  const modlist = new ModlistService({ userData, game: fakeGame })
  const catalog = new CatalogService({ userData: path.join(root, 'catalog'), emit: () => undefined })
  await catalog.ensure({ pull: false })
  const svc = new ServerConfigService({ groups, modlist, game: fakeGame, settings, userData, catalog, emit: () => undefined, emitState: () => undefined })

  const bare = path.join(root, 'remote.git')
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
  await svc.addGroup({ remote: { kind: 'git', url: bare, branch: 'main' } })

  console.log('\n2) view of an empty repository')
  const before = await svc.view()
  const rowFor = (view: ServerConfigView, id: string) => view.rows.find((r) => r.id === id)
  check(before.rows.length === total, `every installed mod is listed (${before.rows.length} rows)`)
  check(
    BUNDLED_MODS.every((m) => rowFor(before, m.uniqueId)?.bundled && !rowFor(before, m.uniqueId)?.inConfig),
    'the built-ins are tagged as such and not part of the config'
  )
  check(before.unpushed, 'with nothing pushed yet, the config counts as unpushed')

  console.log('\n3) push, then look again immediately (the fetch cache must not serve a pre-push snapshot)')
  const pushed = await svc.create()
  console.log(`  pushed: ${pushed.message}`)
  const after = await svc.view()
  check(after.hasModlist, 'the pushed modlist.json5 is visible right away')
  check(!after.remoteEmpty, 'the repository is not reported as empty right away')
  check(after.rows.length === total, `all ${total} mods are still listed after the push`)
  check(USER_MODS.every((m) => rowFor(after, m.uniqueId)?.inConfig), 'the user mods are part of the server config now')
  check(BUNDLED_MODS.every((m) => !rowFor(after, m.uniqueId)?.inConfig), 'the built-ins stay out of it')
  check(!after.unpushed, 'nothing is left unpushed')

  console.log('\n4) the repository itself')
  const config = await fs.readFile(path.join(groups.workDir((await groups.list())[0].id), 'modlist.json5'), 'utf8')
  for (const m of USER_MODS) check(config.includes(m.uniqueId), `modlist.json5 lists ${m.uniqueId}`)
  for (const m of BUNDLED_MODS) check(!config.includes(m.uniqueId), `modlist.json5 does not list ${m.uniqueId}`)
  const pushedFolders = (await fs.readdir(path.join(groups.workDir((await groups.list())[0].id), 'mods')).catch(() => [])).sort()
  console.log(`  mod folders in the repository: ${pushedFolders.join(', ') || '(none)'}`)
  check(
    USER_MODS.every((m) => pushedFolders.includes(m.folder)) && BUNDLED_MODS.every((m) => !pushedFolders.includes(m.folder)),
    'only the user mods were pushed into mods/'
  )

  console.log(`\nSMAPI would load ${total}; the app lists ${after.rows.length}, ${USER_MODS.length} of them in the server config.`)
  console.log('BUNDLED OK')
}

void main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

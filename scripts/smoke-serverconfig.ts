// End-to-end server-config flow against a real repository, using a TEMP copy of the Mods folder.
//   node out/smoke-serverconfig.cjs <repoUrl> [branch]
import os from 'node:os'
import path from 'node:path'
import { promises as fs, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppSettings } from '../src/shared/types'
import { ServerConfigService } from '../src/main/server-config'
import { CatalogService } from '../src/main/catalog'
import { GroupStore } from '../src/main/sync/groups'
import { JsonStore, plainCodec } from '../src/main/store'
import { ModlistService } from '../src/main/modlist/service'
import type { GameService } from '../src/main/game'
import { findGameCandidates } from '../src/main/paths'
import { readGameVersion, readSmapiInfo } from '../src/main/game'
import { installModZips, scanMods } from '../src/main/mods'
import { readHistory } from '../src/main/sync/history'

// Test-only helper: fetch a GitHub release zip (the app itself never downloads mods).
async function fetchGithubZip(repo: string, dest: string): Promise<string> {
  const rel = (await (await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'StarDoring-smoke' } })).json()) as { assets: { name: string; browser_download_url: string }[] }
  const asset = rel.assets.find((a) => a.name.endsWith('.zip'))
  if (!asset) throw new Error(`no zip asset in ${repo}`)
  const file = path.join(dest, asset.name)
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'StarDoring-smoke' } })
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file))
  return file
}

async function main(): Promise<void> {
  const [url, branch = 'main'] = process.argv.slice(2)
  if (!url) throw new Error('usage: smoke-serverconfig <repoUrl> [branch]')
  const root = path.join(os.tmpdir(), 'stardoring-smoke-serverconfig')
  await fs.rm(root, { recursive: true, force: true })
  const userData = path.join(root, 'userData')
  const modsDir = path.join(root, 'Mods')
  const tmp = path.join(root, 'tmp')
  for (const d of [userData, modsDir, tmp]) await fs.mkdir(d, { recursive: true })

  const [game] = await findGameCandidates()
  if (!game) throw new Error('game not found')
  const smapi = await readSmapiInfo(game.path)
  const gameVersion = await readGameVersion(game.path)
  const fakeGame = {
    getInfo: async () => ({ platform: process.platform, found: true, gameDir: game.path, gameVersion, source: game.source, candidates: [], smapi, dataDir: '', savesDir: '', savesDirExists: false, modsDir, smapiLogPath: null, lastRun: null, running: false }),
    requireModsDir: () => modsDir,
    requireGameDir: () => game.path,
    installSmapi: async () => ({ ok: false, message: 'not in smoke test' })
  } as unknown as GameService

  const settings = new JsonStore<AppSettings>(path.join(userData, 'settings.json'), () => ({ gameDirOverride: null, savesDirOverride: null, activeGroupId: null, localModsOnly: false, authorName: 'StarDöring smoke', authorEmail: 'smoke@stardoring.local' }))
  const groups = new GroupStore(userData, plainCodec)
  const modlist = new ModlistService({ userData, game: fakeGame })
  const catalog = new CatalogService({ userData: path.join(os.tmpdir(), 'stardoring-catalog-test'), emit: () => undefined })
  await catalog.ensure({ pull: false }) // reuse the index built by catalog-test when present
  const svc = new ServerConfigService({ groups, modlist, game: fakeGame, settings, userData, catalog, emit: (p) => { if (p.phase !== 'done') console.log('  progress:', p.phase, p.message ?? '') }, emitState: (st) => console.log('  state:', st.status, st.message ?? '') })

  console.log('1) no group:', (await svc.view()).warnings)
  const created = await svc.addGroup({ remote: { kind: 'git', url, branch } })
  console.log('   name read from the config inside the repo:', created.name)
  let view = await svc.view()
  console.log('2) view:', { hasModlist: view.hasModlist, rows: view.rows.length, unpushed: view.unpushed, remoteEmpty: view.remoteEmpty })

  // Obtain a mod the way a user would (browser → zip → Install from zip); here fetched from GitHub by the TEST.
  const zip = await fetchGithubZip('chsiao58/EvenBetterArtisanGoodIcons', tmp)
  const inst = await installModZips(modsDir, [zip], tmp)
  console.log('3) installed from zip:', inst.installed, inst.errors)
  const ebagi = (await scanMods(modsDir)).find((m) => /artisan/i.test(m.name))
  if (!ebagi) throw new Error('EBAGI not installed')
  await fs.writeFile(path.join(ebagi.folderPath, 'config.json'), `{ "Smoke": ${Date.now()} }\n`)
  await svc.addInstalled([ebagi.uniqueId]) // Push never adds installed-but-unlisted mods on its own
  await svc.setNote(ebagi.uniqueId, 'my own note')
  { // draft survives a pull (only Revert drops it)
    await svc.pull()
    const v0 = await svc.view({ fetch: false })
    const r0 = v0.rows.find((r) => r.id.toLowerCase() === ebagi.uniqueId.toLowerCase())
    if (!v0.draft || r0?.note !== 'my own note') throw new Error('pull discarded the draft')
    console.log('3b) draft survived a pull:', { draft: v0.draft, note: r0?.note })
  }
  if (catalog.getStatus().ready) {
    const hit = catalog.search('Automate', 1)[0]
    if (hit) await svc.addFromCatalog([hit.id])
  }
  view = await svc.view()
  console.log('4) before push:', view.rows.map((r) => `${r.name}:${r.state}${r.inRepo ? ' [repo]' : ''} cfg=${r.configState}`), 'unpushed:', view.unpushed)

  const pushed = await svc.push()
  console.log('5) push:', pushed.message, '| modsPushed:', pushed.modsPushed, '\n   details:', pushed.details)
  if (pushed.modsPushed < 1 || !/my own note/.test(pushed.modlistText)) throw new Error('mod folder or note not pushed')
  const [head] = await readHistory(groups.workDir(created.id), 1)
  console.log('6) history head:', head?.subject, '|', head?.details)
  if (!head?.details.length) throw new Error('commit details missing')

  // Another device: delete the local mod and its config → pull restores both from the repo.
  await fs.rm(ebagi.folderPath, { recursive: true, force: true })
  const pulled = await svc.pull()
  console.log('7) pull:', pulled.message, '| installed:', pulled.installed, '| missing:', pulled.missing, '| configsApplied:', pulled.configsApplied, '| errors:', pulled.errors)
  const restored = await fs.readFile(path.join(ebagi.folderPath, 'config.json'), 'utf8').catch(() => '')
  if (!pulled.installed.length || !/Smoke/.test(restored)) throw new Error('mod not restored from the repository')
  view = await svc.view()
  console.log('8) after pull:', view.rows.map((r) => `${r.name}:${r.state}${r.inRepo ? ' [repo]' : ''} cfg=${r.configState} note=${r.note ?? ''}`), 'unpushed:', view.unpushed)
  if (view.unpushed) throw new Error('expected nothing unpushed after pull')
  const again = await svc.push()
  console.log('9) push again:', again.message)
  if (again.commit) throw new Error('expected nothing to push')

  // offline check: an unreachable host must not throw – the global state goes to "offline"
  const dead = await groups.create({ name: '', remote: { kind: 'git', url: 'https://nonexistent.invalid/nobody/repo.git', branch: 'main' } })
  await svc.setActive(dead.id)
  const quiet = await svc.pullQuietly({ timeoutMs: 60_000 })
  const st = svc.getState()
  console.log('10) offline pullQuietly →', quiet, '| state:', st.status, '| online:', st.online)
  if (quiet !== null || st.status !== 'offline' || st.online) throw new Error('offline handling not as expected')
  console.log('SERVERCONFIG OK')
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })

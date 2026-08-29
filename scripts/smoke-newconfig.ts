// "If the repository is empty or a new branch is selected, a new config will be created" – checked against
// local bare repositories, no network: npm run smoke:newconfig
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { AppSettings } from '../src/shared/types'
import { ServerConfigService } from '../src/main/server-config'
import { CatalogService } from '../src/main/catalog'
import { GroupStore } from '../src/main/sync/groups'
import { JsonStore, plainCodec } from '../src/main/store'
import { ModlistService } from '../src/main/modlist/service'
import type { GameService } from '../src/main/game'
import { runGit } from '../src/main/sync/git'

async function bareRepo(dir: string, seedBranch?: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await runGit(['init', '-q', '--bare', '-b', 'main', dir])
  if (seedBranch) {
    const work = `${dir}-seed`
    await fs.mkdir(work, { recursive: true })
    await runGit(['init', '-q', '-b', seedBranch, work])
    await fs.writeFile(path.join(work, 'README.md'), '# existing repository\n')
    await runGit(['add', '-A'], { cwd: work })
    await runGit(['-c', 'user.name=seed', '-c', 'user.email=seed@local', 'commit', '-q', '-m', 'seed'], { cwd: work })
    await runGit(['remote', 'add', 'origin', dir], { cwd: work })
    await runGit(['push', '-q', 'origin', `${seedBranch}:${seedBranch}`], { cwd: work })
  }
  return dir
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), 'stardoring-smoke-newconfig')
  await fs.rm(root, { recursive: true, force: true })
  const userData = path.join(root, 'userData')
  const modsDir = path.join(root, 'Mods')
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(modsDir, { recursive: true })

  const fakeGame = {
    getInfo: async () => ({ platform: process.platform, found: true, gameDir: root, gameVersion: '1.6.15', source: 'manual', candidates: [], smapi: { installed: true, version: '4.3.2', launcherPath: null }, dataDir: '', savesDir: '', savesDirExists: false, modsDir, smapiLogPath: null, lastRun: null, running: false }),
    requireModsDir: () => modsDir,
    requireGameDir: () => root,
    installSmapi: async () => ({ ok: false, message: 'not in smoke test' })
  } as unknown as GameService

  const settings = new JsonStore<AppSettings>(path.join(userData, 'settings.json'), () => ({ gameDirOverride: null, savesDirOverride: null, activeGroupId: null, localModsOnly: false, authorName: 'StarDöring smoke', authorEmail: 'smoke@stardoring.local' }))
  const groups = new GroupStore(userData, plainCodec)
  const modlist = new ModlistService({ userData, game: fakeGame })
  const catalog = new CatalogService({ userData: path.join(root, 'catalog'), emit: () => undefined })
  await catalog.ensure({ pull: false })
  const svc = new ServerConfigService({ groups, modlist, game: fakeGame, settings, userData, catalog, emit: () => undefined, emitState: () => undefined })

  const check = async (label: string, url: string, branch: string): Promise<void> => {
    console.log(`\n— ${label} (branch "${branch}")`)
    const group = await groups.create({ name: '', remote: { kind: 'git', url, branch } })
    await settings.update({ activeGroupId: group.id })
    const before = await svc.view()
    console.log('  view:', { remoteEmpty: before.remoteEmpty, hasModlist: before.hasModlist, rows: before.rows.length })
    // A branch that is not on the server yet is seeded with an empty config (committed locally, published by the first push).
    if (!before.hasModlist || before.rows.filter((r) => !r.bundled).length !== 0 || !before.aheadOfServer) throw new Error(`${label}: expected a seeded empty config that is not on the server yet`)

    const res = await svc.create()
    console.log('  create:', res.message, '· commit', res.commit)
    const after = await svc.view()
    console.log('  after:', { hasModlist: after.hasModlist, name: after.group?.name })
    if (!after.hasModlist) throw new Error(`${label}: no config was created`)

    const { stdout } = await runGit(['ls-remote', '--heads', url])
    const heads = stdout.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean)
    console.log('  remote branches:', heads.join(', '))
    if (!heads.includes(`refs/heads/${branch}`)) throw new Error(`${label}: branch ${branch} was not created on the remote`)
    await groups.remove(group.id)
  }

  // a) a completely empty repository
  await check('empty repository', await bareRepo(path.join(root, 'empty.git')), 'main')
  // b) an existing repository, but a branch that does not exist yet
  await check('existing repo, new branch', await bareRepo(path.join(root, 'seeded.git'), 'main'), 'season2')

  console.log('\nOK – both cases create a fresh config.')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

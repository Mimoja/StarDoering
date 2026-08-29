// Exercises the system-git backend against a real repository. Usage:
//   node out/smoke-git.cjs <url> [branch] [sshKeyPath] [--push]
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { GitRemote, listRemoteBranches } from '../src/main/sync/git-remote'
import { findGit, listSshKeys } from '../src/main/sync/git'

async function main(): Promise<void> {
  const [url, branch = 'main', key = '', flag = ''] = process.argv.slice(2)
  console.log('git:', await findGit())
  console.log('ssh keys:', (await listSshKeys()).map((k) => k.name).join(', '))
  if (!url) return
  const config = { kind: 'git' as const, url, branch, sshKeyPath: key || null }
  console.log('branches on the server:', await listRemoteBranches(config))
  if (flag !== '--push') return
  const dir = path.join(os.tmpdir(), 'stardoring-smoke-git')
  await fs.rm(dir, { recursive: true, force: true })
  const remote = new GitRemote(config, dir, { name: 'StarDöring smoke test', email: 'stardoring@localhost' })
  await remote.connect((m) => console.log('  ', m))
  console.log('files before:', (await remote.list('')).map((f) => f.path))
  const existing = await remote.read('README.md')
  const text = `# StarDöring sync repository\n\nManaged by StarDöring. Connection test from ${os.hostname()} at ${new Date().toISOString()}.\n`
  await remote.write('README.md', Buffer.from(text))
  await remote.commit(existing ? 'StarDöring: connection test (update)' : 'StarDöring: connection test')
  console.log('pushed. files after:', (await remote.list('')).map((f) => f.path))
  // second connect must be a no-op fetch/reset
  await remote.connect((m) => console.log('  ', m))
  console.log('reconnect ok; README present:', (await remote.read('README.md')) != null)
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})

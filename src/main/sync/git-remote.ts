import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitRemoteConfig } from '../../shared/types'
import { logScope } from '../activity'
import { ensureDir, errorMessage, exists, isDir, rmrf, safeJoin, walk, writeFileAtomic } from '../util/fs'
import { findGit, gitInstallHint, humanizeGitError, runGit, type GitAuth } from './git'

const log = logScope('git')

export interface RemoteFile {
  // Relative to the clone root, forward slashes.
  path: string
  size: number
}

export interface GitAuthor {
  name: string
  email: string
}

// A push was rejected because another device pushed first; the caller re-fetches and retries.
export class RemoteConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteConflictError'
  }
}

function authOf(config: GitRemoteConfig): GitAuth {
  return { sshKeyPath: config.sshKeyPath ?? null, sshPassphrase: config.sshPassphrase, username: config.username, token: config.token }
}

// The app-managed clone of one profile's repository: connect() hard-resets it to the remote branch,
// the service writes into it, commit() commits and pushes.
export class GitRemote {
  private readonly dir: string

  constructor(
    private readonly config: GitRemoteConfig,
    workDir: string,
    private readonly author: GitAuthor
  ) {
    this.dir = path.resolve(workDir)
    if (!config.url?.trim()) throw new Error('Git repository URL is missing')
  }

  private get branch(): string {
    return (this.config.branch || 'main').trim()
  }

  private git(args: string[], timeoutMs?: number, quiet?: boolean): Promise<{ stdout: string; stderr: string }> {
    return runGit(args, { cwd: this.dir, auth: authOf(this.config), timeoutMs, quiet })
  }

  // Files in the working copy

  async read(p: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(safeJoin(this.dir, p))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async write(p: string, data: Buffer): Promise<void> {
    await writeFileAtomic(safeJoin(this.dir, p), data)
  }

  async list(prefix: string): Promise<RemoteFile[]> {
    const dir = prefix ? safeJoin(this.dir, prefix) : this.dir
    if (!(await isDir(dir))) return []
    const entries = await walk(dir, { skip: (_rel, e) => e.name === '.git' || e.name.endsWith('.tmp') })
    return entries.map((e) => ({ path: prefix ? `${prefix.replace(/\/$/, '')}/${e.rel}` : e.rel, size: e.size }))
  }

  // Clone, fetch, branches

  private async hasCommits(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '-q', 'HEAD'], undefined, true)
      return true
    } catch {
      return false
    }
  }

  private async currentBranch(): Promise<string | null> {
    try {
      return (await this.git(['symbolic-ref', '--short', 'HEAD'], undefined, true)).stdout.trim() || null
    } catch {
      return null
    }
  }

  private async initFresh(): Promise<void> {
    log.info(`Starting a fresh "${this.branch}" history for ${this.config.url}`)
    await rmrf(this.dir)
    await ensureDir(this.dir)
    try {
      await this.git(['init', '-q', '-b', this.branch], undefined, true)
    } catch {
      await this.git(['init', '-q'])
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`])
    }
    await this.git(['remote', 'add', 'origin', this.config.url])
  }

  // Clone on first use, otherwise fetch and hard-reset to the remote branch. A branch that is not on
  // the server yet becomes an empty local history (published by the first commit()).
  async connect(onMessage?: (msg: string) => void): Promise<void> {
    const git = await findGit()
    if (!git.available) throw new Error(gitInstallHint())
    await ensureDir(path.dirname(this.dir))

    if (!(await exists(path.join(this.dir, '.git')))) {
      onMessage?.('Cloning repository…')
      log.info(`Cloning ${this.config.url} (branch ${this.branch})`, { detail: `into ${this.dir}` })
      const started = Date.now()
      await rmrf(this.dir)
      try {
        await runGit(['clone', '-q', '--branch', this.branch, '--single-branch', this.config.url, this.dir], { auth: authOf(this.config), quiet: true })
        log.info('Clone finished', { durationMs: Date.now() - started })
      } catch (e) {
        const msg = errorMessage(e)
        if (!/Remote branch .* not found|remote HEAD refers to nonexistent ref|empty repository|couldn't find remote ref/i.test(msg)) {
          log.fail(`Cloning ${this.config.url} failed`, e, { detail: humanizeGitError(e) })
          throw new Error(`Git clone failed: ${humanizeGitError(e)}`)
        }
        log.info(`The repository has no branch "${this.branch}" yet – starting a fresh history`)
      }
      if (!(await exists(path.join(this.dir, '.git'))) || !(await this.hasCommits())) await this.initFresh()
    } else {
      await this.git(['remote', 'set-url', 'origin', this.config.url])
      await this.resetToRemote(onMessage)
    }
    await fs.access(this.dir, fs.constants.W_OK)
  }

  private async resetToRemote(onMessage?: (msg: string) => void): Promise<void> {
    onMessage?.('Fetching latest changes…')
    log.info(`Fetching ${this.config.url} (branch ${this.branch})`)
    const started = Date.now()
    try {
      await this.git(['fetch', '-q', '--prune', 'origin', this.branch], undefined, true)
    } catch (e) {
      const msg = errorMessage(e)
      if (/couldn't find remote ref|Remote branch .* not found|remote HEAD refers/i.test(msg)) {
        // Not on the server: keep a local-only history already on this branch, otherwise start empty.
        if ((await this.currentBranch()) === this.branch && (await this.hasCommits())) {
          log.info(`Branch "${this.branch}" is not on the server yet – keeping the local history`)
          return
        }
        log.info(`Branch "${this.branch}" does not exist on the server yet – starting an empty history for it`)
        await this.initFresh()
        return
      }
      log.fail('Fetch failed', e, { detail: humanizeGitError(e) })
      throw new Error(`Git fetch failed: ${humanizeGitError(e)}`)
    }
    await this.git(['checkout', '-q', '-f', '-B', this.branch, 'FETCH_HEAD'])
    await this.git(['clean', '-fdq'])
    const head = (await this.git(['log', '-1', '--pretty=%h %s'])).stdout.trim()
    log.info(`Working copy is at ${head || 'the fetched commit'}`, { durationMs: Date.now() - started })
  }

  // Start the configured branch from another server branch's content and publish it right away.
  async createBranchFrom(source: string): Promise<void> {
    const src = source.trim()
    if (!src) throw new Error('Source branch is missing')
    log.info(`Creating branch "${this.branch}" from "${src}"`)
    await this.git(['fetch', '-q', 'origin', src])
    await this.git(['checkout', '-q', '-f', '-B', this.branch, 'FETCH_HEAD'])
    await this.git(['clean', '-fdq'])
    try {
      await this.git(['push', '-q', '-u', 'origin', `${this.branch}:${this.branch}`])
    } catch (e) {
      throw new Error(`Could not create branch "${this.branch}" on the server: ${humanizeGitError(e)}`)
    }
  }

  async isEmptyHistory(): Promise<boolean> {
    return !(await this.hasCommits())
  }

  // Local commits the server does not have; a never-pushed branch counts as ahead.
  async hasUnpushedCommits(): Promise<boolean> {
    if (!(await this.hasCommits())) return false
    try {
      const { stdout } = await this.git(['rev-list', '--count', `origin/${this.branch}..HEAD`], undefined, true)
      return Number(stdout.trim()) > 0
    } catch {
      return true
    }
  }

  // Commit locally without pushing; false when nothing changed.
  async commitLocal(message: string): Promise<boolean> {
    await this.git(['add', '-A'])
    const { stdout } = await this.git(['status', '--porcelain'])
    if (!stdout.trim()) return false
    await this.git(['-c', `user.name=${this.author.name}`, '-c', `user.email=${this.author.email}`, 'commit', '-q', '-m', message])
    return true
  }

  // Commit whatever changed and push; throws RemoteConflictError when the push is rejected.
  async commit(message: string): Promise<void> {
    await this.git(['add', '-A'])
    const { stdout } = await this.git(['status', '--porcelain'])
    const changed = Boolean(stdout.trim())
    if (!changed && !(await this.hasUnpushedCommits())) {
      log.info('Nothing to commit – the working copy matches the repository')
      return
    }
    if (changed) {
      const subject = message.split('\n')[0]
      log.info(`Committing as ${this.author.name} <${this.author.email}>: ${subject}`, { detail: stdout.trim() })
      await this.git(['-c', `user.name=${this.author.name}`, '-c', `user.email=${this.author.email}`, 'commit', '-q', '-m', message])
    } else {
      log.info(`Publishing local commits of branch "${this.branch}"`)
    }
    const started = Date.now()
    try {
      await this.git(['push', '-q', '-u', 'origin', `${this.branch}:${this.branch}`], undefined, true)
      log.info(`Pushed to ${this.config.url} (branch ${this.branch})`, { durationMs: Date.now() - started })
    } catch (e) {
      const msg = errorMessage(e)
      if (/rejected|fetch first|non-fast-forward|failed to push some refs/i.test(msg)) {
        log.warn('Push rejected – another device pushed first, retrying on top of their version')
        throw new RemoteConflictError('Push rejected – another device pushed first, retrying.')
      }
      log.fail('Push failed', e, { detail: humanizeGitError(e) })
      throw new Error(`Git push failed: ${humanizeGitError(e)}`)
    }
  }
}

// Branch names on the server (`git ls-remote --heads`); empty for an empty repository.
export async function listRemoteBranches(config: GitRemoteConfig): Promise<string[]> {
  const { stdout } = await runGit(['ls-remote', '--heads', config.url.trim()], { auth: authOf(config), timeoutMs: 60_000 })
  return stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean)
    .map((r) => r.replace('refs/heads/', ''))
}

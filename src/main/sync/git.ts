import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promises as fs, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import type { GitInfo, SshKeyInfo } from '../../shared/types'
import { gitInstallHint as sharedGitInstallHint } from '../../shared/git'
import { logScope } from '../activity'
import { errorMessage, isFile } from '../util/fs'

const log = logScope('git')

export interface GitAuth {
  sshKeyPath?: string | null
  sshPassphrase?: string
  username?: string
  token?: string
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(message)
    this.name = 'GitError'
  }
}

let cachedGit: GitInfo | null = null
// The last git we told the log about – re-detection must not repeat the same line.
let loggedGit: string | null = null

function logGit(info: GitInfo): void {
  const id = `${info.version ?? 'missing'}@${info.path ?? ''}`
  if (loggedGit === id) {
    log.debug(info.available ? `git ${info.version} (${info.path})` : 'git is still missing')
    return
  }
  loggedGit = id
  if (info.available) log.info(`Using git ${info.version}`, { detail: info.path })
  else log.warn(gitInstallHint())
}

// Locate the system git binary (cached).
export async function findGit(refresh = false): Promise<GitInfo> {
  if (cachedGit && !refresh) return cachedGit
  const candidates = ['git']
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'))
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }
  for (const bin of candidates) {
    try {
      const { stdout } = await exec(bin, ['--version'], {}, 10_000)
      const m = /git version (\S+)/.exec(stdout)
      cachedGit = { available: true, path: bin, version: m?.[1] ?? stdout.trim() }
      logGit(cachedGit)
      return cachedGit
    } catch {}
  }
  cachedGit = { available: false, path: null, version: null }
  logGit(cachedGit)
  return cachedGit
}

export const gitInstallHint = (): string => sharedGitInstallHint(process.platform)

function quoteForSh(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

let askpassScript: string | null = null

// ssh takes passphrases only from an SSH_ASKPASS program: a tiny script printing an env var (never on disk).
function ensureAskpassScript(): string {
  if (askpassScript) return askpassScript
  const dir = path.join(os.tmpdir(), `stardoring-${os.userInfo().username}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    askpassScript = path.join(dir, 'askpass.cmd')
    writeFileSync(askpassScript, '@echo %STARDORING_SSH_PASSPHRASE%\r\n')
  } else {
    askpassScript = path.join(dir, 'askpass.sh')
    writeFileSync(askpassScript, '#!/bin/sh\nprintf \'%s\\n\' "$STARDORING_SSH_PASSPHRASE"\n', { mode: 0o700 })
    chmodSync(askpassScript, 0o700)
  }
  return askpassScript
}

// Environment that makes git non-interactive and applies the selected SSH key / passphrase / HTTPS token.
function gitEnv(auth: GitAuth = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }
  delete env['GIT_DIR']
  delete env['GIT_WORK_TREE']
  const usePassphrase = Boolean(auth.sshKeyPath && auth.sshPassphrase)
  const sshOpts = ['-o StrictHostKeyChecking=accept-new']
  if (!usePassphrase) sshOpts.unshift('-o BatchMode=yes')
  if (auth.sshKeyPath) sshOpts.unshift(`-i ${quoteForSh(auth.sshKeyPath)}`, '-o IdentitiesOnly=yes')
  env['GIT_SSH_COMMAND'] = `ssh ${sshOpts.join(' ')}`
  if (usePassphrase) {
    env['SSH_ASKPASS'] = ensureAskpassScript()
    env['SSH_ASKPASS_REQUIRE'] = 'force'
    env['STARDORING_SSH_PASSPHRASE'] = auth.sshPassphrase
    if (!env['DISPLAY']) env['DISPLAY'] = ':0' // older OpenSSH only consults SSH_ASKPASS when DISPLAY is set
  }
  if (auth.token) {
    const basic = Buffer.from(`${auth.username || 'x-access-token'}:${auth.token}`, 'utf8').toString('base64')
    env['GIT_CONFIG_COUNT'] = '2'
    env['GIT_CONFIG_KEY_0'] = 'http.extraHeader'
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`
    env['GIT_CONFIG_KEY_1'] = 'credential.helper'
    env['GIT_CONFIG_VALUE_1'] = ''
  }
  return env
}

function exec(bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, env: opts.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : null
        reject(new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${String(stderr || error.message).trim()}`, args, String(stderr), code))
      } else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// Everything git prints, trimmed to something a log line can carry.
function gitOutput(stdout: string, stderr: string): string | undefined {
  const text = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n')
  return text || undefined
}

// Run a git command. `quiet` marks calls that are *expected* to fail sometimes (probing for a commit, cloning a
// branch that is not there yet): their failure is logged at debug level – the caller reports the real outcome.
export async function runGit(args: string[], opts: { cwd?: string; auth?: GitAuth; timeoutMs?: number; quiet?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  const git = await findGit()
  if (!git.available || !git.path) throw new Error(gitInstallHint())
  const label = `git ${args.join(' ')}`
  const started = Date.now()
  try {
    const res = await exec(git.path, args, { cwd: opts.cwd, env: gitEnv(opts.auth) }, opts.timeoutMs ?? 10 * 60_000)
    log.debug(label, { durationMs: Date.now() - started, detail: [opts.cwd ? `cwd: ${opts.cwd}` : null, gitOutput(res.stdout, res.stderr)].filter(Boolean).join('\n') })
    return res
  } catch (e) {
    const detail = [opts.cwd ? `cwd: ${opts.cwd}` : null, e instanceof GitError ? e.stderr.trim() : errorMessage(e)].filter(Boolean).join('\n')
    const write = opts.quiet ? log.debug : log.error
    write(`${label} failed`, { durationMs: Date.now() - started, detail })
    throw e
  }
}

// Turn common git/ssh failures into actionable messages.
export function humanizeGitError(e: unknown): string {
  const text = e instanceof GitError ? e.stderr || e.message : e instanceof Error ? e.message : String(e)
  if (/Permission denied \(publickey\)/i.test(text)) return 'SSH authentication failed (publickey). Select the SSH key that has access to this repository, or add your key to ssh-agent.'
  if (/Host key verification failed/i.test(text)) return 'SSH host key verification failed. Connect once from a terminal (ssh -T git@host) to accept the host key.'
  if (/could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled/i.test(text)) return 'HTTPS authentication failed. Enter a personal access token, or use an SSH URL with a key.'
  if (/Repository not found|does not appear to be a git repository|not found/i.test(text)) return 'Repository not found (check the URL and that the key/token has access).'
  if (/Could not resolve host|Network is unreachable|Connection timed out|Failed to connect/i.test(text)) return 'Cannot reach the git host – check your network connection.'
  if (/passphrase|Enter passphrase/i.test(text)) return 'The SSH key is passphrase-protected. Load it into ssh-agent (ssh-add) or use a key without passphrase.'
  return text.trim().split('\n').slice(-3).join('\n')
}

// Private keys in ~/.ssh (files starting with "-----BEGIN", excluding .pub/.ppk).
export async function listSshKeys(): Promise<SshKeyInfo[]> {
  const dir = path.join(os.homedir(), '.ssh')
  const out: SshKeyInfo[] = []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    if (/\.(pub|ppk|der|pem\.pub)$/i.test(name) || /^(known_hosts|config|authorized_keys|environment|rc)/i.test(name)) continue
    const p = path.join(dir, name)
    if (!(await isFile(p))) continue
    try {
      const fh = await fs.open(p, 'r')
      const buf = Buffer.alloc(40)
      const { bytesRead } = await fh.read(buf, 0, 40, 0)
      await fh.close()
      if (buf.subarray(0, bytesRead).toString('utf8').startsWith('-----BEGIN')) out.push({ name, path: p })
    } catch {
      // unreadable – skip
    }
  }
  return out
}

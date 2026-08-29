import type { DeepLink, GitRemoteConfig } from './types'

// The URL scheme StarDöring registers with the OS.
export const PROTOCOL = 'stardoering'

// Link actions we understand; everything else is refused instead of guessed at.
const ACTIONS = new Set(['add-profile', 'addprofile', 'add', 'profile'])

// Clone transports a link may name. The URL goes straight into `git clone`, and git has transports that run
// commands (`ext::`) or read the local disk (`file:`) – a link out of a chat message must never reach those.
const ALLOWED_SCHEMES = new Set(['https', 'http', 'ssh'])

// Anything that would be invisible in the confirmation dialog.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_GLOBAL = /[\x00-\x1f\x7f]+/g

// Undo one layer of percent-encoding, leaving malformed input alone.
function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// A repository URL out of a link, validated and (for the `host/owner/repo` short form) completed. Throws a user-facing message.
export function normalizeGitUrl(input: string): string {
  const url = decodeMaybe(input).trim()
  if (!url) throw new Error('The link carries no repository URL.')
  if (CONTROL_CHARS.test(url)) throw new Error('The repository URL contains control characters.')
  if (url.length > 2048) throw new Error('The repository URL is too long.')
  // A leading dash would arrive at git as an option rather than as a URL.
  if (url.startsWith('-')) throw new Error(`“${url}” is not a repository URL.`)

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme) {
    if (!ALLOWED_SCHEMES.has(scheme)) throw new Error(`Links cannot use “${scheme}:” repository URLs – https://, ssh:// and git@host:path only.`)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`“${url}” is not a repository URL.`)
    }
    if (!parsed.hostname) throw new Error(`“${url}” names no server.`)
    // A password in the URL would end up stored in plain text – credentials belong in the profile's settings.
    if (parsed.password) throw new Error('Repository URLs with a password in them are not accepted – add the credentials in the profile settings instead.')
    return url
  }

  // scp-style, the form GitHub hands out for SSH: git@github.com:you/mods.git
  if (/^[\w.+-]+@[\w.-]+:(?!\/)\S+$/.test(url)) return url
  // host/owner/repo without a scheme – the shape people copy out of a browser's address bar.
  if (/^[\w-]+(\.[\w-]+)+\/\S+$/.test(url)) return `https://${url}`
  throw new Error(`“${url}” is not a repository URL.`)
}

// A branch name out of a link. Empty falls back to `main`; anything git would not take is refused.
export function normalizeBranch(input: string | null | undefined): string {
  const branch = decodeMaybe((input ?? '').trim())
  if (!branch) return 'main'
  const bad = branch.length > 200 || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || !/^[\w./+-]+$/.test(branch)
  if (bad) throw new Error(`“${branch}” is not a branch name.`)
  return branch
}

// A display name out of a link: one line, no control characters, short enough for the sidebar.
function normalizeName(input: string | null): string | null {
  if (input == null) return null
  const name = decodeMaybe(input).replace(CONTROL_CHARS_GLOBAL, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return name || null
}

// Parse a stardoering://add-profile?url=…&branch=… link (README lists every accepted shape) into an intent the user
// confirms in the UI – nothing is fetched here. Throws a user-facing message when the link is malformed or refused.
export function parseDeepLink(raw: string): DeepLink {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/^[<"']+/, '')
    .replace(/[>"']+$/, '')
  const m = new RegExp(`^${PROTOCOL}:(?://)?(.*)$`, 'i').exec(trimmed)
  if (!m) throw new Error(`Not a ${PROTOCOL}:// link: ${trimmed}`)

  let rest = m[1]
  const hash = rest.indexOf('#')
  const fragment = hash < 0 ? '' : rest.slice(hash + 1)
  if (hash >= 0) rest = rest.slice(0, hash)
  const mark = rest.indexOf('?')
  const params = new URLSearchParams(mark < 0 ? '' : rest.slice(mark + 1))
  // Browsers hand over a trailing slash when there is no path at all (stardoering://add-profile/?url=…).
  const body = (mark < 0 ? rest : rest.slice(0, mark)).replace(/\/+$/, '')

  const slash = body.indexOf('/')
  const head = slash < 0 ? body : body.slice(0, slash)
  let tail = body
  if (ACTIONS.has(head.toLowerCase())) {
    tail = slash < 0 ? '' : body.slice(slash + 1)
  } else if (head && !/[.:@]/.test(head)) {
    // A word that is neither an action nor the start of a URL – a link for a feature we do not have.
    throw new Error(`Unknown link: ${PROTOCOL}://${head}`)
  }

  const url = params.get('url') ?? params.get('repo') ?? params.get('git') ?? tail
  return {
    kind: 'addProfile',
    url: normalizeGitUrl(url),
    branch: normalizeBranch(params.get('branch') ?? params.get('ref') ?? fragment),
    name: normalizeName(params.get('name'))
  }
}

// The link that adds this repository as a profile (the Copy link button). No name on purpose: a profile is named by
// its modlist.json5, and a name in the link would go stale the moment the server is renamed.
export function buildProfileLink(remote: Pick<GitRemoteConfig, 'url' | 'branch'>): string {
  const url = remote.url.trim()
  const branch = (remote.branch || 'main').trim()
  // Ordinary clone URLs are left readable – people paste these into chat. Anything that would break the
  // query string (or be swallowed by a chat client) is percent-encoded instead.
  const safe = (v: string): string => (/^[\w.:/@+-]+$/.test(v) ? v : encodeURIComponent(v))
  return `${PROTOCOL}://add-profile?url=${safe(url)}&branch=${safe(branch)}`
}

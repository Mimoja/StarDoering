import { logScope } from '../activity'

const log = logScope('modlist')

const USER_AGENT = 'StarDoring'
const REQUEST_TIMEOUT_MS = 20_000

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Turn fetch's terse failures into something a user can act on.
export function describeFetchError(url: string, e: unknown): string {
  const host = hostOf(url)
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `Timed out talking to ${host}`
  const cause = (e as { cause?: { code?: string; message?: string } } | null)?.cause
  const detail = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))
  return `Could not reach ${host} (${detail}) – are you offline?`
}

export async function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const started = Date.now()
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    log.debug(`GET ${url} → HTTP ${res.status}`, { durationMs: Date.now() - started })
    return res
  } catch (e) {
    log.error(`GET ${url} failed: ${describeFetchError(url, e)}`, { durationMs: Date.now() - started })
    throw new Error(describeFetchError(url, e))
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { gitInstallHint as sharedGitInstallHint } from '@shared/git'

export const api = window.api

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
  setData: (d: T | null) => void
}

// Run an async loader on mount (and whenever `deps` change); exposes reload().
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await loaderRef.current())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}

// Run one action at a time with a busy label; rejected calls become a toast instead of a crash.
export function useBusy(notify: (m: string) => void): { busy: string | null; run: (label: string, fn: () => Promise<unknown>) => Promise<void> } {
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label)
      try {
        await fn()
      } catch (e) {
        notify(errorText(e))
      } finally {
        setBusy(null)
      }
    },
    [notify]
  )
  return { busy, run }
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// Toast text for a pull: the summary plus the actual errors, not just their count.
export function pullSummary(r: { message: string; errors: string[]; missing: string[] }): string {
  const lines = [r.message]
  for (const e of r.errors) lines.push(`• ${e}`)
  if (r.missing.length) lines.push(`• nobody pushed the files yet: ${r.missing.join(', ')}`)
  return lines.join('\n')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '–'
  return new Date(ms).toLocaleString()
}

export const gitInstallHint = (): string => sharedGitInstallHint(api.app.platform)

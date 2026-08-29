import { useSyncExternalStore } from 'react'
import type { LogEntry } from '@shared/types'
import { api } from './hooks'

const MAX_ROWS = 3000

// Keep one entry per seq and stay in order – the initial list() and live batches can overlap.
function merge(a: LogEntry[], b: LogEntry[]): LogEntry[] {
  if (a.length === 0) return b.slice(-MAX_ROWS)
  const bySeq = new Map<number, LogEntry>()
  for (const e of a) bySeq.set(e.seq, e)
  for (const e of b) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq).slice(-MAX_ROWS)
}

// One subscription to the main process for the whole window: the sidebar panel and the maximized view read the same
// entries, so opening the big view costs nothing and both scroll in step.
let entries: LogEntry[] = []
let error: string | null = null
const listeners = new Set<() => void>()
let started = false

function emit(): void {
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  api.activity.onEntries((batch) => {
    entries = merge(entries, batch)
    emit()
  })
  void api.activity
    .list()
    .then((all) => {
      entries = merge(all, entries)
      emit()
    })
    .catch((e: unknown) => {
      error = e instanceof Error ? e.message : String(e)
      emit()
    })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useActivityEntries(): LogEntry[] {
  return useSyncExternalStore(subscribe, () => entries)
}

export function useActivityError(): string | null {
  return useSyncExternalStore(subscribe, () => error)
}

// Empty the buffer in the main process and here (the log file keeps everything).
export async function clearActivity(): Promise<void> {
  await api.activity.clear()
  entries = []
  emit()
}

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CatalogItem, CatalogStatus, ModlistEntry } from '../shared/types'
import { parseUpdateKey } from './modlist/format'
import { findGit, gitInstallHint, humanizeGitError, runGit } from './sync/git'
import { logScope } from './activity'
import { errorMessage, exists, isDir, readJson, writeJson } from './util/fs'

const log = logScope('catalog')

export const DATASET_URL = 'https://github.com/Pathoschild/StardewModDataset.git'
const DATASET_BRANCH = 'main'
const INDEX_VERSION = 6

interface DatasetPage {
  Site?: string
  Id?: number
  Name?: string
  Author?: string
  // The mod page's body text – raw HTML, only used when a manifest has no description of its own.
  Description?: string
  PageUrl?: string
  Version?: string
  Updated?: string
  Downloads?: { Type?: string; Version?: string; Uploaded?: string; Mods?: { Type?: string; Manifest?: { UniqueId?: string; Name?: string; Description?: string; Version?: string; UpdateKeys?: string[]; ContentPackFor?: { UniqueId?: string } | null; Dependencies?: { UniqueId?: string }[] | null; EntryDll?: string | null } | null }[] }[]
}

// One entry of a page download – a page can bundle several mods (a framework plus its content packs).
type DatasetMod = NonNullable<NonNullable<DatasetPage['Downloads']>[number]['Mods']>[number]

// An item while indexing: the content-pack target stays a raw UniqueID (its name is only known once every page
// is read), next to the two helpers that decide which page wins the name and the version.
type Indexing = Omit<CatalogItem, 'contentPackFor' | 'needs'> & { _updated: number; _nameRank: number; _contentPackFor: string | null }

interface IndexFile {
  version: number
  commit: string
  builtAt: number
  items: CatalogItem[]
}

// One readable line out of a manifest or page description: page bodies are raw HTML, so tags and
// entities come out and the result is capped to a blurb.
function shortDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text
}

// One link per store: a UniqueID often has several pages on a site (translations, re-uploads); the
// canonical one carries the ID the index settled on (lowest Nexus ID = original upload), else the first seen.
function canonicalPages(item: Pick<CatalogItem, 'pages' | 'nexus' | 'curseforge' | 'moddrop'>): CatalogItem['pages'] {
  const idFor: Record<string, number | null | undefined> = { Nexus: item.nexus, CurseForge: item.curseforge, ModDrop: item.moddrop }
  const out: CatalogItem['pages'] = []
  for (const page of item.pages) {
    if (out.some((o) => o.label === page.label)) continue
    const id = idFor[page.label]
    const canonical = id != null ? item.pages.find((c) => c.label === page.label && new RegExp(`/${id}(?:[/?#-]|$)`).test(c.url)) : undefined
    out.push(canonical ?? page)
  }
  return out
}

// The catalog is Pathoschild's StardewModDataset (every mod on Nexus, CurseForge and ModDrop with its manifests),
// cloned (~20 MB) into app data and pulled once per start; the UniqueID index is rebuilt when its commit changes.
export class CatalogService {
  private readonly dir: string
  private readonly indexFile: string
  private items: CatalogItem[] = []
  private byId = new Map<string, CatalogItem>()
  private status: CatalogStatus = { ready: false, updating: false, count: 0, commit: null, updatedAt: null, error: null }
  private ensured: Promise<CatalogStatus> | null = null

  constructor(
    private readonly deps: { userData: string; emit: (s: CatalogStatus) => void }
  ) {
    this.dir = path.join(deps.userData, 'catalog', 'StardewModDataset')
    this.indexFile = path.join(deps.userData, 'catalog', 'index.json')
  }

  getStatus(): CatalogStatus {
    return { ...this.status }
  }

  private setStatus(patch: Partial<CatalogStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.emit(this.getStatus())
  }

  // Load the cached index (instant) and then clone/pull the dataset once; concurrent callers share the same run.
  ensure(opts: { pull?: boolean } = { pull: true }): Promise<CatalogStatus> {
    if (!this.ensured) this.ensured = this.run(opts.pull !== false).finally(() => undefined)
    return this.ensured
  }

  private async run(pull: boolean): Promise<CatalogStatus> {
    await this.loadIndex()
    // loadIndex() drops an index of an older app version: rebuild it from the dataset already on disk rather than
    // waiting for a pull – otherwise a version bump empties the catalog for everyone who is offline.
    if (this.items.length === 0 && (await exists(path.join(this.dir, '.git')))) {
      try {
        const head = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: this.dir })).stdout.trim()
        log.info('The cached mod catalog index is outdated – rebuilding it from the dataset on disk')
        await this.buildIndex(head)
      } catch (e) {
        log.debug('Could not rebuild the index from the dataset on disk', { detail: errorMessage(e) })
      }
    }
    if (!pull) return this.getStatus()
    this.setStatus({ updating: true, error: null })
    try {
      const git = await findGit()
      if (!git.available) throw new Error(gitInstallHint())
      await fs.mkdir(path.dirname(this.dir), { recursive: true })
      if (!(await exists(path.join(this.dir, '.git')))) {
        log.info('Cloning the mod catalog (Pathoschild/StardewModDataset) – this takes a moment on the first start')
        await runGit(['clone', '-q', '--depth', '1', '--branch', DATASET_BRANCH, '--single-branch', DATASET_URL, this.dir], { timeoutMs: 10 * 60_000 })
      } else {
        log.info('Updating the mod catalog')
        await runGit(['fetch', '-q', '--depth', '1', 'origin', DATASET_BRANCH], { cwd: this.dir, timeoutMs: 10 * 60_000 })
        await runGit(['reset', '-q', '--hard', `origin/${DATASET_BRANCH}`], { cwd: this.dir })
      }
      const commit = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: this.dir })).stdout.trim()
      if (commit !== this.status.commit || this.items.length === 0) await this.buildIndex(commit)
      else log.info(`Mod catalog is up to date (${this.items.length} mods, ${commit})`)
      this.setStatus({ updating: false, ready: true, error: null })
    } catch (e) {
      // Offline or git trouble: keep whatever index we have.
      const message = humanizeGitError(e) || errorMessage(e)
      log.warn(`Mod catalog could not be updated – using the ${this.items.length > 0 ? 'previously downloaded' : 'empty'} index`, { detail: message })
      this.setStatus({ updating: false, error: message })
    }
    return this.getStatus()
  }

  private async loadIndex(): Promise<void> {
    const cached = await readJson<IndexFile | null>(this.indexFile, null)
    if (cached && cached.version === INDEX_VERSION && Array.isArray(cached.items)) {
      log.debug(`Loaded the cached mod catalog (${cached.items.length} mods, built ${new Date(cached.builtAt).toLocaleString()})`)
      this.items = cached.items
      this.byId = new Map(this.items.map((i) => [i.id.toLowerCase(), i]))
      this.setStatus({ ready: true, count: this.items.length, commit: cached.commit, updatedAt: cached.builtAt })
    }
  }

  private async buildIndex(commit: string): Promise<void> {
    log.info(`Indexing the mod catalog (${commit})`)
    const started = Date.now()
    const dataDir = path.join(this.dir, 'dataset', 'data')
    const items = new Map<string, Indexing>()
    // UniqueID → the mods it needs (dependencies + the framework a content pack is for). Collected as sets
    // keyed by the dependent so a mod published on several sites is still counted once.
    const needs = new Map<string, Set<string>>()
    for (const site of ['Nexus', 'CurseForge', 'ModDrop']) {
      const siteDir = path.join(dataDir, site)
      if (!(await isDir(siteDir))) continue
      for (const bucket of await fs.readdir(siteDir)) {
        const bucketDir = path.join(siteDir, bucket)
        if (!(await isDir(bucketDir))) continue
        for (const file of await fs.readdir(bucketDir)) {
          if (!file.endsWith('.json')) continue
          let page: DatasetPage
          try {
            page = JSON.parse(await fs.readFile(path.join(bucketDir, file), 'utf8')) as DatasetPage
          } catch {
            continue
          }
          this.addPage(items, needs, page)
        }
      }
    }
    const requiredBy = new Map<string, number>()
    for (const targets of needs.values()) for (const t of targets) requiredBy.set(t, (requiredBy.get(t) ?? 0) + 1)
    // Dependencies are stored as UniqueIDs; every mod of the dataset is known by now, so each one also gets the
    // name it is listed under – "needs Content Patcher" says more in a row than "needs Pathoschild.ContentPatcher".
    const label = (id: string): { id: string; name: string } => {
      const known = items.get(id.toLowerCase())
      return { id: known?.id ?? id, name: known?.name ?? id }
    }
    this.items = [...items.values()]
      .map(({ _updated, _nameRank, _contentPackFor, ...item }) => ({
        ...item,
        pages: canonicalPages(item),
        requiredBy: requiredBy.get(item.id.toLowerCase()) ?? 0,
        contentPackFor: _contentPackFor ? label(_contentPackFor) : null,
        needs: [...(needs.get(item.id.toLowerCase()) ?? [])]
          .filter((d) => d !== _contentPackFor)
          .sort()
          .map(label)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    this.byId = new Map(this.items.map((i) => [i.id.toLowerCase(), i]))
    const index: IndexFile = { version: INDEX_VERSION, commit, builtAt: Date.now(), items: this.items }
    await writeJson(this.indexFile, index)
    log.info(`Mod catalog ready – ${this.items.length} mods`, { durationMs: Date.now() - started })
    this.setStatus({ ready: true, count: this.items.length, commit, updatedAt: index.builtAt })
  }

  private addPage(items: Map<string, Indexing>, needs: Map<string, Set<string>>, page: DatasetPage): void {
    const updated = page.Updated ? Date.parse(page.Updated) || 0 : 0
    const downloads = [...(page.Downloads ?? [])].sort((a, b) => Date.parse(b.Uploaded ?? '') - Date.parse(a.Uploaded ?? '')) // newest first
    const seen = new Set<string>()
    const mods: DatasetMod[] = []
    for (const dl of downloads) {
      for (const mod of dl.Mods ?? []) {
        const uniqueId = mod.Manifest?.UniqueId?.trim()
        if (!uniqueId || seen.has(uniqueId.toLowerCase())) continue
        if (mod.Type && !/^(Smapi|ContentPack)$/i.test(mod.Type)) continue
        seen.add(uniqueId.toLowerCase())
        mods.push(mod)
      }
    }
    // A bundle (framework plus content packs) would fill the search with a dozen rows of the same page title, so its
    // entries are labelled with the manifest name ("(SMI) SCI - Abigail"); a single-mod page keeps the nicer page title.
    const bundled = mods.length > 1
    for (const mod of mods) {
      const manifest = mod.Manifest
      const id = manifest?.UniqueId?.trim()
      if (!id) continue
      const key = id.toLowerCase()
      const target = needs.get(key) ?? new Set<string>()
      for (const dep of manifest?.Dependencies ?? []) if (dep?.UniqueId?.trim()) target.add(dep.UniqueId.trim().toLowerCase())
      if (manifest?.ContentPackFor?.UniqueId?.trim()) target.add(manifest.ContentPackFor.UniqueId.trim().toLowerCase())
      needs.set(key, target)
      const prev = items.get(key)
      const sources: Partial<Pick<CatalogItem, 'nexus' | 'curseforge' | 'moddrop' | 'github'>> = {}
      if (page.Site === 'Nexus' && page.Id) sources.nexus = page.Id
      if (page.Site === 'CurseForge' && page.Id) sources.curseforge = page.Id
      if (page.Site === 'ModDrop' && page.Id) sources.moddrop = page.Id
      for (const k of manifest?.UpdateKeys ?? []) {
        const parsed = parseUpdateKey(k)
        if (!parsed) continue
        if (parsed.site === 'github' && !sources.github) sources.github = parsed.id
        if (parsed.site === 'nexus' && !sources.nexus && /^\d+$/.test(parsed.id)) sources.nexus = Number(parsed.id)
      }
      // Name priority: the original Nexus page (lowest ID – translations/re-uploads come later) > other sites > manifest.
      const nameRank = page.Site === 'Nexus' && page.Id ? page.Id : page.Site === 'CurseForge' || page.Site === 'ModDrop' ? 1_000_000_000 + (page.Id ?? 0) : 2_000_000_000
      const displayName = (bundled ? manifest?.Name?.trim() || page.Name?.trim() : page.Name?.trim() || manifest?.Name?.trim()) || id
      const pages: CatalogItem['pages'] = []
      if (page.PageUrl && page.Site) pages.push({ label: page.Site, url: page.PageUrl })
      if (sources.github) pages.push({ label: 'GitHub', url: `https://github.com/${sources.github}` })
      const item: Indexing = {
        id,
        requiredBy: 0,
        pages,
        // The manifest line is the author's own summary; the page description is a whole HTML body and
        // only stands in when the manifest has none.
        description: shortDescription(manifest?.Description) ?? shortDescription(page.Description),
        name: displayName,
        pageName: bundled ? page.Name?.trim() || null : null,
        _contentPackFor: manifest?.ContentPackFor?.UniqueId?.trim().toLowerCase() || null,
        author: page.Author?.trim() ?? '',
        kind: manifest?.ContentPackFor?.UniqueId ? 'content-pack' : 'smapi',
        version: manifest?.Version ?? page.Version ?? null,
        updated: updated || null,
        pageUrl: page.PageUrl ?? null,
        nexus: sources.nexus ?? null,
        curseforge: sources.curseforge ?? null,
        moddrop: sources.moddrop ?? null,
        github: sources.github ?? null,
        _updated: updated,
        _nameRank: nameRank
      }
      if (!prev) {
        items.set(key, item)
        continue
      }
      const takeName = nameRank < prev._nameRank
      const newer = updated >= prev._updated
      const merged: Indexing = {
        ...prev,
        name: takeName ? item.name : prev.name,
        // Every store that carries the mod, deduped by URL – the Website button offers all of them.
        pages: [...prev.pages, ...pages.filter((l) => !prev.pages.some((p) => p.url === l.url))],
        description: takeName ? (item.description ?? prev.description) : (prev.description ?? item.description),
        pageName: takeName ? item.pageName : prev.pageName,
        author: takeName ? item.author || prev.author : prev.author || item.author,
        _contentPackFor: prev._contentPackFor ?? item._contentPackFor,
        _nameRank: Math.min(prev._nameRank, nameRank),
        version: newer ? (item.version ?? prev.version) : (prev.version ?? item.version),
        updated: Math.max(prev.updated ?? 0, item.updated ?? 0) || null,
        _updated: Math.max(prev._updated, updated),
        nexus: prev.nexus != null && item.nexus != null ? Math.min(prev.nexus, item.nexus) : (prev.nexus ?? item.nexus),
        curseforge: prev.curseforge ?? item.curseforge,
        moddrop: prev.moddrop ?? item.moddrop,
        github: prev.github ?? item.github,
        pageUrl: prev.pageUrl
      }
      if (merged.nexus) merged.pageUrl = `https://www.nexusmods.com/stardewvalley/mods/${merged.nexus}`
      else if (takeName) merged.pageUrl = item.pageUrl ?? prev.pageUrl
      items.set(key, merged)
    }
  }

  // What to show before anything is typed. The dataset has no ratings or download counts, so the ranking is "how
  // many other mods need this one" – which puts Content Patcher, Json Assets, GMCM and the other frameworks first.
  top(limit = 30): CatalogItem[] {
    return [...this.items]
      .filter((i) => i.requiredBy > 0)
      .sort((a, b) => b.requiredBy - a.requiredBy || (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, Math.max(1, Math.min(limit, 200)))
  }

  get(id: string): CatalogItem | null {
    return this.byId.get(id.toLowerCase()) ?? null
  }

  // Substring search over name, UniqueID and author; name-prefix matches first.
  search(query: string, limit = 50): CatalogItem[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const scored: { item: CatalogItem; score: number }[] = []
    for (const item of this.items) {
      const name = item.name.toLowerCase()
      const id = item.id.toLowerCase()
      const author = item.author.toLowerCase()
      let score = 0
      if (name === q || id === q) score = 4
      else if (name.startsWith(q)) score = 3
      else if (name.includes(q) || id.includes(q)) score = 2
      else if (author.includes(q)) score = 1
      if (score > 0) scored.push({ item, score })
    }
    return scored
      .sort((a, b) => b.score - a.score || b.item.requiredBy - a.item.requiredBy || (b.item.updated ?? 0) - (a.item.updated ?? 0))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((s) => s.item)
  }

  // Turn a catalog item into a modlist entry (page links only – nothing is downloaded automatically).
  toEntry(item: CatalogItem): ModlistEntry {
    const entry: ModlistEntry = { id: item.id, name: item.name, enabled: true }
    if (item.nexus) entry.nexus = item.nexus
    if (item.github) entry.github = item.github
    if (item.pageUrl) entry.url = item.pageUrl
    return entry
  }
}

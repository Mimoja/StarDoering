import { useEffect, useState } from 'react'
import type { CatalogItem, CatalogStatus } from '@shared/types'
import type { PageProps } from '../App'
import { Badge, Button, Empty, List, Modal, Row, Section } from '../components/ui'
import { api, errorText, useBusy } from '../lib/hooks'

// Catalog search on its own page; everything picked here lands in the config draft, which the Mods page pushes.
export default function AddMod({ notify, profile }: PageProps) {
  const { busy, run } = useBusy(notify)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogItem[]>([])
  const [searching, setSearching] = useState(false)
  const [status, setStatus] = useState<CatalogStatus | null>(null)
  useEffect(() => {
    void api.catalog.status().then(setStatus).catch(() => undefined)
    return api.catalog.onStatus(setStatus)
  }, [])

  // debounce: the dataset holds ~20k mods, so search on a pause, not on every keystroke
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.catalog.search(q, 50)
        if (!cancelled) setResults(r)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  const add = (item: CatalogItem): Promise<void> =>
    run(`add-${item.id}`, async () => {
      await api.serverConfig.addFromCatalog([item.id])
      notify(`Added “${item.name}” to the server config – push it on the Mods page.`)
    })

  const searchable = query.trim().length >= 2
  const shown = searchable ? results : []
  const count = status?.count ?? 0
  const statusLine = !status
    ? 'checking the mod dataset…'
    : status.error
      ? status.error
      : status.updating
        ? `${count.toLocaleString()} mods · updating…`
        : status.ready
          ? `${count.toLocaleString()} mods${status.commit ? ` · dataset ${status.commit}` : ''}`
          : 'the mod dataset is not ready yet'

  return (
    <>
      <h1>Add a mod</h1>
      {!profile && <p className="sub">No profile selected – pick one in the sidebar to add mods to its server config.</p>}

      <Section
        title="Search the mod dataset"
        actions={<span className="sub">{statusLine}</span>}
      >
        <input className="grow" type="search" placeholder="Search by name, author or UniqueID…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {searchable && !searching && results.length === 0 && <Empty>Nothing found for “{query.trim()}”.</Empty>}
        {!searchable && <Empty>{status?.error ? status.error : 'Type a mod name, author or UniqueID to search the dataset.'}</Empty>}
        {shown.length > 0 && (
          <div className="list">
            {shown.map((item) => (
              <CatalogRow key={item.id} item={item} busy={busy === `add-${item.id}`} onAdd={() => void add(item)} notify={notify} />
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

// Every site the dataset saw the mod on – the page URL is only a fallback for entries without a site ID.
function sourceLinks(item: CatalogItem): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = []
  if (item.nexus) links.push({ label: 'Nexus', url: `https://www.nexusmods.com/stardewvalley/mods/${item.nexus}` })
  if (item.curseforge) links.push({ label: 'CurseForge', url: `https://www.curseforge.com/projects/${item.curseforge}` })
  if (item.moddrop) links.push({ label: 'ModDrop', url: `https://www.moddrop.com/stardew-valley/mods/${item.moddrop}` })
  if (item.github) links.push({ label: 'GitHub', url: `https://github.com/${item.github}` })
  if (links.length === 0 && item.pageUrl) links.push({ label: 'Website', url: item.pageUrl })
  return links
}

// One dataset entry. Its description and full dependency list unfold on demand – 30 rows of prose would bury the list.
function CatalogRow({ item, busy, onAdd, notify }: { item: CatalogItem; busy: boolean; onAdd: () => void; notify: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [links, setLinks] = useState(false)
  const visit = (url: string): void => void api.app.openExternal(url).catch((e) => notify(errorText(e)))
  const byline = [item.author ? `by ${item.author}` : null, item.pageName ? `on “${item.pageName}”` : null].filter(Boolean).join(' · ')
  // Some mods list a dozen dependencies; the row names the first three and keeps the rest for the unfolded panel.
  const needs = item.needs.slice(0, 3).map((n) => n.name).join(', ')
  // The dataset's own page URLs when the index has them, the reconstructed ones otherwise.
  const sources = item.pages.length > 0 ? item.pages : sourceLinks(item)
  const unfoldable = Boolean(item.description) || item.needs.length > 3

  return (
    <div className="mod-entry">
    <div className="mod catalog">
      <div className="mod-name">
        <span className="name">
          {unfoldable ? (
            <button className="disclosure" aria-expanded={open} title={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
          ) : (
            // Same width as the triangle, so names line up whether a row unfolds or not.
            <span className="disclosure" aria-hidden="true" />
          )}
          {item.name}
        </span>
        <span className="sub">{byline}</span>
      </div>

      <div className="mod-meta">
        <span>{item.version || '–'}</span>
        <span className="sub mono" title={item.id}>
          {item.id}
        </span>
      </div>

      <div className="mod-badges">
        {item.kind === 'content-pack' ? <Badge tone="info">content pack</Badge> : <Badge>C# mod</Badge>}
        {item.requiredBy > 0 && (
          <span className="sub" title="how many other mods list it as a dependency or are a content pack for it">
            {item.requiredBy.toLocaleString()} mods need it
          </span>
        )}
        {item.contentPackFor && (
          <span className="sub" title={item.contentPackFor.id}>
            for {item.contentPackFor.name}
          </span>
        )}
        {item.needs.length > 0 && (
          <span className="sub" title={item.needs.map((n) => `${n.name} (${n.id})`).join('\n')}>
            needs {needs}
            {item.needs.length > 3 ? ` +${item.needs.length - 3}` : ''}
          </span>
        )}
        {item.updated && <span className="sub">updated {new Date(item.updated).toLocaleDateString()}</span>}
      </div>

      <div className="mod-actions">
        {sources.length > 0 && (
          <Button
            title={sources.length === 1 ? sources[0].url : `${sources.length} pages: ${sources.map((l) => l.label).join(', ')}`}
            onClick={() => (sources.length === 1 ? visit(sources[0].url) : setLinks(true))}
          >
            Website{sources.length > 1 ? ` (${sources.length})` : ''}
          </Button>
        )}
        <Button busy={busy} onClick={onAdd}>
          + Add
        </Button>
      </div>
    </div>

    {open && (
      <div className="mod-detail">
        {item.description && <p>{item.description}</p>}
        {item.needs.length > 0 && (
          <p className="sub">Needs: {item.needs.map((n) => n.name).join(', ')}</p>
        )}
      </div>
    )}

    {links && (
      <Modal title={item.name} onClose={() => setLinks(false)}>
        <p className="sub">This mod is published in {sources.length} places.</p>
        <List>
          {sources.map((link) => (
            <Row
              key={link.url}
              label={link.label}
              actions={
                <Button
                  onClick={() => {
                    visit(link.url)
                    setLinks(false)
                  }}
                >
                  Open
                </Button>
              }
            >
              <span className="sub mono">{link.url}</span>
            </Row>
          ))}
        </List>
      </Modal>
    )}
    </div>
  )
}

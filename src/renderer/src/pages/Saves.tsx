import { useEffect, useState } from 'react'
import { saveFolderPrefix } from '@shared/saves'
import type { SaveInfo } from '@shared/types'
import { Badge, Button, Empty, ErrorBox, Modal, Row, Section } from '../components/ui'
import { api, errorText, formatBytes, formatDate, useAsync, useBusy } from '../lib/hooks'

export default function Saves({ notify }: { notify: (m: string) => void }) {
  const saves = useAsync(() => api.saves.list())
  const { busy, run } = useBusy(notify)
  const [copying, setCopying] = useState<SaveInfo | null>(null)
  const open = (folder?: string) => api.saves.open(folder).catch((e) => notify(errorText(e)))

  // The list loads when the tab opens; re-read it on focus too, since saving happens in the game.
  useEffect(() => {
    const onFocus = (): void => void saves.reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const duplicate = (save: SaveInfo, farmName: string) =>
    run(save.folder, async () => {
      const copy = await api.saves.duplicate(save.folder, farmName)
      setCopying(null)
      await saves.reload()
      notify(`Copied "${save.folder}" to "${copy.folder}".`)
    })

  return (
    <>
      <h1>Saves</h1>
      {copying && <DuplicateDialog save={copying} busy={busy !== null} onClose={() => setCopying(null)} onConfirm={(farmName) => void duplicate(copying, farmName)} />}
      <Section
        title={saves.data ? `${saves.data.length} save${saves.data.length === 1 ? '' : 's'}` : 'Saves'}
        actions={
          <>
            <Button onClick={() => void open()}>Open saves folder</Button>
          </>
        }
      >
        {saves.error && <ErrorBox>{saves.error}</ErrorBox>}
        {saves.data && saves.data.length === 0 && <Empty>No saves found.</Empty>}
        {saves.data && saves.data.length > 0 && (
          <div className="list">
            <div className="save head">
              <div>Farm</div>
              <div>Farmer</div>
              <div>Date</div>
              <div>Played</div>
              <div>Money</div>
              <div>Game</div>
              <div>Last saved</div>
              <div>Size</div>
              <div />
            </div>
            {saves.data.map((s) => (
              <div className="save" key={s.folder}>
                <div className="stack">
                  <span className="name">{s.farmName}</span>
                  <span className="sub mono">{s.folder}</span>
                </div>
                <div>{s.farmerName}</div>
                <div>
                  {s.season} {s.day}, Year {s.year}
                </div>
                <div>{s.hoursPlayed} h</div>
                <div>{s.money.toLocaleString()}g</div>
                <div>{s.gameVersion ?? '–'}</div>
                <div>{formatDate(s.lastModified)}</div>
                <div className="sub">
                  {formatBytes(s.sizeBytes)} {s.hasBackup && <Badge>backup</Badge>}
                </div>
                <div className="item-actions">
                  <Button variant="ghost" title="Copy this save into a second one the game keeps apart" busy={busy === s.folder} disabled={busy !== null} onClick={() => setCopying(s)}>
                    Duplicate
                  </Button>
                  <Button variant="ghost" onClick={() => void open(s.folder)}>
                    Folder
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

// Duplicating asks for the farm name: in the game's load menu it is all that tells two copies apart.
function DuplicateDialog({ save, busy, onClose, onConfirm }: { save: SaveInfo; busy: boolean; onClose: () => void; onConfirm: (farmName: string) => void }) {
  const [farmName, setFarmName] = useState(`${save.farmName} copy`)
  const prefix = saveFolderPrefix(farmName.trim())

  return (
    <Modal title={`Duplicate "${save.farmName}"`} onClose={onClose}>
      <p className="sub">
        A full copy of {save.folder}, as a save of its own – the original stays untouched. Both farms keep {save.farmerName}, {save.season} {save.day} of year {save.year} and every last
        coin.
      </p>
      <Row label="Farm name">
        <input className="grow" value={farmName} onChange={(e) => setFarmName(e.target.value)} spellCheck={false} autoFocus onKeyDown={(e) => e.key === 'Enter' && prefix && !busy && onConfirm(farmName)} />
      </Row>
      <p className="sub">
        {prefix ? (
          <>
            Saved in <span className="mono">{prefix}_…</span> – the game drops everything but letters and digits from the farm name.
          </>
        ) : (
          'The farm name needs at least one letter or digit – the game builds the folder name out of it.'
        )}
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <Button variant="primary" busy={busy} disabled={!prefix} onClick={() => onConfirm(farmName)}>
          Duplicate
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  )
}

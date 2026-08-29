import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModConfigDoc, ModConfigEdit, ModConfigField, ModConfigValue } from '@shared/types'
import { Badge, Button, Empty, ErrorBox, Modal } from './ui'
import { api, errorText, useAsync } from '../lib/hooks'

// A mod's config.json as a form, one row per setting, with description and default where the mod documents them (Content
// Patcher packs do); the rest is inferred from the values. No Save button: a change is written as it is made (on blur for typed fields).
export function ModConfigPanel({ folder, onSaved, notify }: { folder: string; onSaved?: () => void | Promise<void>; notify: (m: string) => void }) {
  const doc = useAsync(() => api.modConfig.read(folder), [folder])
  const d = doc.data

  return (
    <>
      {doc.error && <ErrorBox>{doc.error}</ErrorBox>}
      {!d && doc.loading && <Empty>Reading the mod's config…</Empty>}
      {d && <ModConfigBody key={d.path} doc={d} setDoc={doc.setData} onSaved={onSaved} notify={notify} />}
    </>
  )
}

// The same panel in a dialog – for the Settings button on a mod row, where the list stays behind it.
export function ModConfigMenu({ folder, modName, onClose, onSaved, notify }: { folder: string; modName?: string; onClose: () => void; onSaved?: () => void | Promise<void>; notify: (m: string) => void }) {
  return (
    <Modal title={modName ? `${modName} · settings` : 'Settings'} onClose={onClose} wide>
      <ModConfigPanel folder={folder} onSaved={onSaved} notify={notify} />
    </Modal>
  )
}

const keyOf = (f: ModConfigField): string => f.path.join('.')
const same = (a: ModConfigValue, b: ModConfigValue): boolean => JSON.stringify(a) === JSON.stringify(b)

function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function ModConfigBody({
  doc,
  setDoc,
  onSaved,
  notify
}: {
  doc: ModConfigDoc
  setDoc: (d: ModConfigDoc | null) => void
  onSaved?: () => void | Promise<void>
  notify: (m: string) => void
}) {
  // The values as the file had them when this panel opened – what "changed" is measured against, and what a revert puts back.
  const [original] = useState<Record<string, ModConfigValue>>(() => Object.fromEntries(doc.fields.map((f) => [keyOf(f), f.value])))
  // Values being typed: they belong to the field until it is left, then they go to disk.
  const [pending, setPending] = useState<Record<string, ModConfigValue>>({})
  // Raw text of the JSON rows while it is being typed – it is not a value until it parses.
  const [jsonText, setJsonText] = useState<Record<string, string>>({})
  const [json, setJson] = useState(false)
  const [text, setText] = useState(doc.text ?? '{}')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // Writes go one after another: config.json is read, changed and written whole every time.
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  // A field commits what was typed into it when it is left – but folding the row away (or closing the
  // dialog) unmounts the input without a blur, so whatever is still held gets written on the way out.
  const leaving = useRef({ pending, fields: doc.fields, folder: doc.folder, notify })
  leaving.current = { pending, fields: doc.fields, folder: doc.folder, notify }
  useEffect(
    () => () => {
      const { pending: held, fields, folder, notify: tell } = leaving.current
      const edits: ModConfigEdit[] = []
      for (const [key, value] of Object.entries(held)) {
        const field = fields.find((f) => keyOf(f) === key)
        if (field && !same(value, field.value)) edits.push({ path: field.path, value })
      }
      if (edits.length > 0) void api.modConfig.save(folder, edits).catch((e) => tell(errorText(e)))
    },
    []
  )

  const valueOf = (f: ModConfigField): ModConfigValue => (keyOf(f) in pending ? pending[keyOf(f)] : f.value)
  const isChanged = (f: ModConfigField): boolean => keyOf(f) in original && !same(valueOf(f), original[keyOf(f)])
  const changed = doc.fields.filter(isChanged)

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return doc.fields
    return doc.fields.filter((f) => f.label.toLowerCase().includes(q) || keyOf(f).toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q))
  }, [doc.fields, filter])

  // Run one config.json write after the ones before it, and adopt the document it gives back.
  const write = (label: string, fn: () => Promise<ModConfigDoc>, keys: string[] = []): Promise<void> => {
    const step = queue.current.catch(() => undefined).then(async () => {
      setBusy(label)
      try {
        const next = await fn()
        setDoc(next)
        setPending((prev) => {
          const rest = { ...prev }
          for (const k of keys) delete rest[k]
          return rest
        })
        if (keys.length === 0) setJsonText({})
        setText(next.text ?? '{}')
        await onSaved?.()
      } catch (e) {
        notify(errorText(e))
      } finally {
        setBusy(null)
      }
    })
    queue.current = step
    return step
  }

  // Put one field on disk right away.
  const commit = (f: ModConfigField, value: ModConfigValue): Promise<void> => {
    if (same(value, f.value)) {
      setPending((prev) => {
        const rest = { ...prev }
        delete rest[keyOf(f)]
        return rest
      })
      return Promise.resolve()
    }
    return write(`field-${keyOf(f)}`, () => api.modConfig.save(doc.folder, [{ path: f.path, value }]), [keyOf(f)])
  }

  // Typing does not touch the file – the value is held until the field is left.
  const hold = (f: ModConfigField, value: ModConfigValue): void => setPending((prev) => ({ ...prev, [keyOf(f)]: value }))

  const revertAll = (): Promise<void> => {
    const edits: ModConfigEdit[] = changed.map((f) => ({ path: f.path, value: original[keyOf(f)] }))
    if (edits.length === 0) return Promise.resolve()
    return write('revert', () => api.modConfig.save(doc.folder, edits), changed.map(keyOf))
  }

  const reset = (): void => {
    const question =
      doc.schemaSource === 'none'
        ? `Reset the settings of “${doc.modName}”?\n\nThe mod does not say what its defaults are, so config.json goes to the trash – the mod writes a fresh one with its defaults the next time the game starts.`
        : `Reset the settings of “${doc.modName}” to the mod's defaults?`
    if (!confirm(question)) return
    void write('reset', () => api.modConfig.reset(doc.folder))
  }

  // Nothing to show a form for: an unparsable file, or a mod that has never written its settings out.
  if (doc.parseError) {
    return (
      <>
        <ErrorBox>config.json could not be read: {doc.parseError}</ErrorBox>
        <JsonEditor text={text} setText={setText} path={doc.path} busy={busy === 'json'} onSave={() => void write('json', () => api.modConfig.saveText(doc.folder, text))} />
      </>
    )
  }
  if (!doc.exists && !doc.canCreate) {
    return <Empty>{doc.modName} has no config.json – either it has no settings, or it has not run yet. Start the game once and its settings show up here.</Empty>
  }
  if (!doc.exists) {
    return (
      <>
        <p className="sub">
          {doc.modName} documents {doc.fields.length} setting{doc.fields.length === 1 ? '' : 's'} but has not written its config.json yet. Write the defaults now and change them here, or start the game
          once and let the mod do it.
        </p>
        <Button variant="primary" busy={busy === 'create'} onClick={() => void write('create', () => api.modConfig.create(doc.folder))}>
          Write config.json
        </Button>
      </>
    )
  }

  return (
    <>
      <div className="cfg-toolbar">
        <span className="sub mono" title={doc.path}>
          {doc.folder}/config.json
        </span>
        {doc.schemaSource === 'content-patcher' && (
          <Badge tone="info" title="Descriptions, allowed values and defaults come from the pack's content.json">
            documented
          </Badge>
        )}
        {doc.truncated && (
          <Badge tone="warn" title="Too many settings for the form – the JSON editor has all of them">
            partial
          </Badge>
        )}
        {changed.length > 0 && !json && (
          <span className="sub">
            {changed.length} setting{changed.length === 1 ? '' : 's'} changed
          </span>
        )}
        <span className="grow" />
        {!json && doc.fields.length > 10 && <input type="search" placeholder="Filter settings…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <Button variant="ghost" onClick={() => setJson(!json)}>
          {json ? 'Form' : 'Edit as JSON'}
        </Button>
      </div>

      {json ? (
        <JsonEditor text={text} setText={setText} path={doc.path} busy={busy === 'json'} onSave={() => void write('json', () => api.modConfig.saveText(doc.folder, text))} />
      ) : (
        <>
          {doc.fields.length === 0 && <Empty>config.json is empty – this mod has nothing to configure.</Empty>}
          {visible.length === 0 && doc.fields.length > 0 && <Empty>No setting matches “{filter}”.</Empty>}
          <div className="cfg-list">
            {visible.map((f, i) => {
              const key = keyOf(f)
              const value = valueOf(f)
              const rowChanged = isChanged(f)
              const heading = f.section && f.section !== visible[i - 1]?.section ? f.section : null
              return (
                <div key={key}>
                  {heading && <div className="subhead">{heading}</div>}
                  <div className={`cfg-row${rowChanged ? ' changed' : ''}`}>
                    <div className="cfg-label">
                      <span className="name" title={key}>
                        {f.label}
                      </span>
                      {f.description && <span className="sub">{f.description}</span>}
                    </div>
                    <div className="cfg-control">
                      <FieldControl
                        field={f}
                        value={value}
                        onHold={(v) => hold(f, v)}
                        onCommit={(v) => void commit(f, v)}
                        text={jsonText[key]}
                        onText={(t) => setJsonText((p) => ({ ...p, [key]: t }))}
                      />
                    </div>
                    <div className="cfg-extra">
                      {rowChanged && (
                        <button className="linkish" title={`Back to ${JSON.stringify(original[key])}`} onClick={() => void commit(f, original[key])}>
                          revert
                        </button>
                      )}
                      {f.hasDefault && !same(value, f.default) && (
                        <button className="linkish" title={`The mod's default: ${JSON.stringify(f.default)}`} onClick={() => void commit(f, f.default)}>
                          default
                        </button>
                      )}
                      {rowChanged && <span className="cfg-mark" aria-label="changed" title="changed since this panel was opened" />}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="cfg-footer">
            <Button variant="ghost" disabled={changed.length === 0} busy={busy === 'revert'} title="Put every changed setting back to what it was when this panel opened" onClick={() => void revertAll()}>
              Revert {changed.length > 0 ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'changes'}
            </Button>
            <Button variant="ghost" busy={busy === 'reset'} onClick={reset}>
              Reset to defaults
            </Button>
            <span className="grow" />
            <span className="sub">Changes are saved as you make them.</span>
          </div>
        </>
      )}
    </>
  )
}

function FieldControl({
  field,
  value,
  onHold,
  onCommit,
  text,
  onText
}: {
  field: ModConfigField
  value: ModConfigValue
  // Keep the value while it is being typed.
  onHold: (v: ModConfigValue) => void
  // Write it to config.json.
  onCommit: (v: ModConfigValue) => void
  text: string | undefined
  onText: (t: string) => void
}) {
  switch (field.type) {
    // Picking is a finished action – these go straight to the file.
    case 'boolean':
      return <input type="checkbox" checked={value === true} onChange={(e) => onCommit(e.target.checked)} />
    case 'number':
      return (
        <input
          type="number"
          step={field.integer ? 1 : 'any'}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onHold(Number.isNaN(e.target.valueAsNumber) ? 0 : e.target.valueAsNumber)}
          onBlur={() => onCommit(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      )
    case 'choice':
      return (
        <select value={String(value ?? '')} onChange={(e) => onCommit(e.target.value)}>
          {/* A value the mod no longer offers still has to be visible instead of silently becoming the first option. */}
          {!(field.choices ?? []).includes(String(value ?? '')) && <option value={String(value ?? '')}>{String(value ?? '') || '(empty)'}</option>}
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )
    case 'choices': {
      // AllowMultiple: the value is a comma-separated list, so each allowed value is a toggle.
      const picked = String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return (
        <div className="chips">
          {(field.choices ?? []).map((c) => {
            const on = picked.includes(c)
            return (
              <button key={c} className={`chip${on ? ' on' : ''}`} onClick={() => onCommit((on ? picked.filter((p) => p !== c) : [...picked, c]).join(', '))}>
                {c}
              </button>
            )
          })}
        </div>
      )
    }
    case 'json': {
      const raw = text ?? JSON.stringify(value)
      const bad = !parses(raw)
      return (
        <textarea
          className={`cfg-json${bad ? ' bad' : ''}`}
          spellCheck={false}
          value={raw}
          onChange={(e) => {
            onText(e.target.value)
            if (parses(e.target.value)) onHold(JSON.parse(e.target.value) as ModConfigValue)
          }}
          onBlur={() => {
            if (parses(raw)) onCommit(JSON.parse(raw) as ModConfigValue)
          }}
        />
      )
    }
    default:
      return (
        <input
          type="text"
          spellCheck={false}
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={(e) => onHold(e.target.value)}
          onBlur={() => onCommit(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      )
  }
}

// The whole file as text, for configs the form cannot represent. This one keeps a Save: half-typed JSON is not
// something to write to disk on every keystroke.
function JsonEditor({ text, setText, path, busy, onSave }: { text: string; setText: (t: string) => void; path: string; busy: boolean; onSave: () => void }) {
  const bad = !parses(text)
  return (
    <>
      <textarea className={`cfg-editor${bad ? ' bad' : ''}`} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="cfg-footer">
        <Button variant="primary" disabled={bad} busy={busy} onClick={onSave}>
          Save
        </Button>
        {bad && <span className="hint">Not valid JSON</span>}
        <span className="grow" />
        <span className="sub mono" title={path}>
          {path}
        </span>
      </div>
    </>
  )
}

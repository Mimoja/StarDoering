import { useEffect, useState, type ReactNode } from 'react'

// A plain block: small uppercase heading + optional actions, no box around it.
export function Section({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      {(title || actions) && (
        <header>
          <h2>{title}</h2>
          <div className="section-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  )
}

// A section whose heading toggles its content; collapsed by default. `actions` sit next to the toggle rather than
// inside it – a button nested in a button is invalid markup and swallows its own clicks.
export function Collapsible({ title, actions, defaultOpen = false, children }: { title: ReactNode; actions?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="section">
      <header>
        <button className="toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="chev">{open ? '▾' : '▸'}</span>
          {title}
        </button>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {open && children}
    </section>
  )
}

// Rows separated by 1px borders.
export function List({ children }: { children: ReactNode }) {
  return <div className="list">{children}</div>
}

// One list row: label | value | actions.
export function Row({ label, actions, className, muted, children }: { label?: ReactNode; actions?: ReactNode; className?: string; muted?: boolean; children?: ReactNode }) {
  const cls = ['item', className, muted ? 'muted' : null].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      {label !== undefined && <div className="item-label">{label}</div>}
      <div className="item-value">{children}</div>
      {actions ? <div className="item-actions">{actions}</div> : null}
    </div>
  )
}

export function Badge({ tone = 'neutral', title, children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; title?: string; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  )
}

export function Button({ variant = 'default', busy, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <button className={`btn btn-${variant}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spinner" /> : null}
      {children}
    </button>
  )
}

// Row action glyphs as inline SVG rather than emoji: they inherit the text colour, stay monochrome in this bare dark
// UI, and render identically everywhere – 🌐/📁 come out as colour emoji on macOS.
const ICON_PATHS: Record<string, ReactNode> = {
  website: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.9 2.1 1.9 10.4 0 12.5M8 1.75c-1.9 2.1-1.9 10.4 0 12.5" />
    </>
  ),
  settings: (
    <>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.5" />
      <circle cx="10.5" cy="8" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </>
  ),
  folder: <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.3 1.6h6.1a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />,
  // The GitHub mark is a solid shape, so it overrides the stroke-only defaults of the set.
  github: (
    <path
      fill="currentColor"
      stroke="none"
      d="M8 .5a7.5 7.5 0 0 0-2.37 14.62c.37.07.51-.16.51-.36l-.01-1.26c-2.09.45-2.53-1-2.53-1-.34-.87-.83-1.1-.83-1.1-.68-.47.05-.46.05-.46.75.05 1.15.77 1.15.77.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.83-3.42-3.71 0-.82.29-1.49.77-2.02-.08-.19-.34-.95.07-1.98 0 0 .63-.2 2.06.77a7.1 7.1 0 0 1 3.75 0c1.43-.97 2.06-.77 2.06-.77.41 1.03.15 1.79.08 1.98.48.53.77 1.2.77 2.02 0 2.89-1.76 3.52-3.43 3.7.27.23.51.69.51 1.39l-.01 2.06c0 .2.14.44.51.36A7.5 7.5 0 0 0 8 .5z"
    />
  ),
  remove: <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />
}

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  )
}

// A square button carrying one glyph; the label is its tooltip and its accessible name.
export function IconButton({ label, name, busy, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; name: IconName; busy?: boolean }) {
  return (
    <button className="btn btn-icon" title={label} aria-label={label} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spinner" /> : <Icon name={name} />}
    </button>
  )
}

export interface PlayOption {
  label: string
  hint?: string
  disabled?: boolean
  busy?: boolean
  onSelect: () => void
}

// The big Play call to action. `menu` turns it into a split button: the alternative launch modes live behind the caret.
export function PlayButton({ busy, hint, icon = '▶', menu, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; hint?: ReactNode; icon?: string; menu?: PlayOption[] }) {
  const [open, setOpen] = useState(false)
  // The caret goes down with the button – while something is starting, and once nothing behind it is left to pick. It
  // stays alive when the button is disabled but an option still works (Steam launches without a detected game folder).
  const menuDead = Boolean(busy) || (menu ?? []).every((m) => m.disabled || m.busy)
  useEffect(() => {
    if (menuDead) setOpen(false)
  }, [menuDead])
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="play-split">
      <button className="play" disabled={busy || rest.disabled} {...rest}>
        <span className="play-label">
          {busy ? <span className="spinner" /> : icon} {children}
        </span>
        {hint && <small>{hint}</small>}
      </button>
      {menu && menu.length > 0 && (
        <>
          <button
            className={`play-more${open ? ' open' : ''}`}
            aria-label="Other launch options"
            aria-expanded={open}
            disabled={menuDead}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
          >
            ▾
          </button>
          {open && (
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              {menu.map((m) => (
                <button
                  key={m.label}
                  disabled={m.disabled || m.busy}
                  onClick={() => {
                    setOpen(false)
                    m.onSelect()
                  }}
                >
                  {m.busy && <span className="spinner" />}
                  <span>{m.label}</span>
                  {m.hint && <small>{m.hint}</small>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Centred dialog over a dimmed backdrop; closes on the backdrop, the × and Escape.
export function Modal({ title, onClose, wide, children }: { title: ReactNode; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="error-box">{children}</div>
}

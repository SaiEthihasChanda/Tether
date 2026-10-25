// Small building blocks: icons, buttons, chips, dialogs, toasts.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { errorText } from './lib.js';

const P = {
  file: 'M5 2.5h5.5L14 6v9.5H5zM10.5 2.5V6H14',
  folder: 'M2.5 5.5V14h13V6.5H9L7.5 4.5h-5z',
  share: 'M12.5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5.5 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12.5 15.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7.3 10l3.4 2M10.7 6 7.3 8',
  download: 'M9 2.5v9M5.5 8 9 11.5 12.5 8M3 14.5h12',
  edit: 'M11.5 3l3.5 3.5L7 14.5H3.5V11z',
  check: 'M3.5 9.5 7 13l7.5-8',
  pause: 'M6.5 4v10M11.5 4v10',
  play: 'M5.5 3.5v11l9-5.5z',
  search: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12 12l3.5 3.5',
  history: 'M3 9a6 6 0 1 0 1.8-4.3M3 3v3.5h3.5M9 6v3.5l2.5 1.5',
  people: 'M6.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 15c0-2.5 2-4.5 4.5-4.5S11 12.5 11 15M12 3.5a2.4 2.4 0 0 1 0 4.4M13.5 10.7c1.6.6 2.5 2.1 2.5 4.3',
  device: 'M3 4h12v7.5H3zM1.5 14h15',
  gear: 'M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM9 1.5v2M9 14.5v2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M1.5 9h2M14.5 9h2M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4',
  list: 'M6 4.5h9.5M6 9h9.5M6 13.5h9.5M2.5 4.5h.5M2.5 9h.5M2.5 13.5h.5',
  box: 'M2.5 5.5 9 2l6.5 3.5v7L9 16l-6.5-3.5zM2.5 5.5 9 9l6.5-3.5M9 9v7',
  activity: 'M1.5 9h3l2-5 4 10 2-5h4',
  open: 'M10 2.5h5.5V8M15.5 2.5 8.5 9.5M13 11v4.5H2.5V5H7',
  copy: 'M6 6h9.5v9.5H6zM3 12V2.5h9.5',
  x: 'M4 4l10 10M14 4 4 14',
  plus: 'M9 3v12M3 9h12',
  alert: 'M9 2 16.5 15h-15zM9 7v3.5M9 13h.01',
  git: 'M5 3v8M5 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM13 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM13 7c0 3-2 4-8 4',
  live: 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 13a5.5 5.5 0 0 1 0-8M13 5a5.5 5.5 0 0 1 0 8',
  trash: 'M3 5h12M7 5V3h4v2M4.5 5l.8 10.5h7.4L13.5 5',
  back: 'M11 3.5 5.5 9l5.5 5.5',
  user: 'M9 8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 15.5c0-3 2.7-5 6-5s6 2 6 5',
  refresh: 'M15 9a6 6 0 1 1-1.8-4.3M15 3v3.5h-3.5',
};

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name]} />
    </svg>
  );
}

export function Logo({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="11.5" cy="16" r="7" fill="none" stroke="var(--brand)" strokeWidth="3.2" />
      <circle cx="20.5" cy="16" r="7" fill="none" stroke="var(--brand)" strokeWidth="3.2" />
    </svg>
  );
}

export const Chip = ({ tone = 'muted', children, title }) => <span className={`chip chip-${tone}`} title={title}>{children}</span>;

/** A button running an async action: busy state, and errors become a toast. */
export function Button({ onClick, children, kind = 'secondary', icon, disabled, small, type = 'button', title, ...rest }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type={type}
      title={title}
      className={`btn btn-${kind}${small ? ' btn-small' : ''}`}
      disabled={disabled || busy}
      onClick={async (e) => {
        if (!onClick) return;
        setBusy(true);
        try {
          await onClick(e);
        } catch (err) {
          toast(errorText(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size={16} />}
      <span>{busy ? 'Working…' : children}</span>
    </button>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    ref.current?.querySelector('input, select, textarea, button.btn-primary')?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><Icon name="x" /></button>}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** A yes/no question with a clear consequence. */
export function Confirm({ title, text, yes = 'Continue', danger, onYes, onClose }) {
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind={danger ? 'danger' : 'primary'} onClick={async () => { await onYes(); onClose(); }}>{yes}</Button>
    </>}>
      <p>{text}</p>
    </Modal>
  );
}

export function Copy({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <Button small icon={done ? 'check' : 'copy'} onClick={async () => {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>{done ? 'Copied' : label}</Button>
  );
}

export function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <h3>{title}</h3>
      <div className="muted">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function Toasts({ children }) {
  const [list, setList] = useState([]);
  const push = (text, tone = 'info') => {
    const id = Math.random();
    setList((l) => [...l, { id, text, tone }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4500);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((x) => <div key={x.id} className={`toast toast-${x.tone}`}>{x.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

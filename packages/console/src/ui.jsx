// Shared building blocks for the console: routing, data loading, icons and small components.
import { useEffect, useState, useCallback } from 'react';

// ---------- routing ----------
export function usePath() {
  const [loc, setLoc] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setLoc(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}

export function go(to) {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function Link({ to, children, className, ...rest }) {
  return (
    <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(to); }} {...rest}>
      {children}
    </a>
  );
}

// ---------- data ----------
export function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => setState({ data }), (error) => setState({ error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

// ---------- formatting ----------
export function timeAgo(d) {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  for (let i = units.length - 1; i >= 0; i--) {
    const [secs, name] = units[i];
    if (s >= secs) {
      const n = Math.round(s / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const handle = (email = '') => email.split('@')[0];

// ---------- icons (16px, stroke-based) ----------
const paths = {
  repo: 'M3 2.5h8.5a1 1 0 0 1 1 1v9.5H4.5a1.5 1.5 0 0 0-1.5 1.5V2.5Zm0 12A1.5 1.5 0 0 1 4.5 13M6 5.5h4',
  file: 'M4 1.75h5.25L12.5 5v9.25H4V1.75ZM9 1.75V5h3.5',
  folder: 'M1.75 3.25h4.5l1.5 1.5h6.5v8.5H1.75V3.25Z',
  people: 'M5.5 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M10.5 3.2a2.2 2.2 0 0 1 0 4.1M12 9.8c1.5.5 2.5 1.9 2.5 3.7',
  history: 'M2.25 8A5.75 5.75 0 1 0 4 3.9M2 1.75v2.5h2.5M8 4.75V8l2.25 1.5',
  gear: 'M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.25 1.25M11.35 11.35l1.25 1.25M3.4 12.6l1.25-1.25M11.35 4.65l1.25-1.25',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  link: 'M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75',
  copy: 'M5.5 5.5V2.25h8.25v8.25H10.5M2.25 5.5h8.25v8.25H2.25V5.5Z',
  check: 'M2.75 8.5 6 11.75l7.25-7.5',
  plus: 'M8 2.5v11M2.5 8h11',
  lock: 'M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3V7Z',
  globe: 'M8 14.25A6.25 6.25 0 1 0 8 1.75a6.25 6.25 0 0 0 0 12.5ZM1.75 8h12.5M8 1.75c1.75 1.9 2.5 3.9 2.5 6.25S9.75 12.35 8 14.25C6.25 12.35 5.5 10.35 5.5 8S6.25 3.65 8 1.75Z',
  download: 'M8 2v8.5M4.75 7.25 8 10.5l3.25-3.25M2.5 13.5h11',
  alert: 'M8 1.75 14.5 13.5h-13L8 1.75ZM8 6v3.5M8 11.5v.25',
  terminal: 'M2.5 3.5l4 4.5-4 4.5M8 12.5h5.5',
  dot: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  trash: 'M2.75 4h10.5M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4',
  signout: 'M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.75 10.75l3.5 3.5',
};

export function Icon({ name, size = 16, className = '', title }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <circle cx="11" cy="16" r="6.5" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="21" cy="16" r="6.5" fill="none" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

// ---------- components ----------
export function Avatar({ email = '?', size = 20 }) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${h} 45% 45%)` }} aria-hidden="true">
      {(email[0] ?? '?').toUpperCase()}
    </span>
  );
}

export const Label = ({ children, tone = 'default', title }) => <span className={`label label-${tone}`} title={title}>{children}</span>;

export function Flash({ tone = 'default', children, icon = 'alert' }) {
  return (
    <div className={`flash flash-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

export const ErrorFlash = ({ error }) => (error ? <Flash tone="danger">{error.message}</Flash> : null);

export function Blankslate({ icon, title, children }) {
  return (
    <div className="blankslate">
      <Icon name={icon} size={24} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Copy({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-icon"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
    >
      <Icon name={done ? 'check' : 'copy'} />
    </button>
  );
}

/** A button that runs an async action, with busy state, optional confirm, and inline error. */
export function Action({ label, onRun, confirm, className = 'btn', disabled, icon, type = 'button' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <span className="action">
      <button
        type={type}
        className={className}
        disabled={busy || disabled}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            await onRun();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {icon && <Icon name={icon} />}
        {busy ? 'Working…' : label}
      </button>
      {error && <span className="inline-error" role="alert">{error.message}</span>}
    </span>
  );
}

export function UnderlineNav({ items, current }) {
  return (
    <nav className="underline-nav" aria-label="Sections">
      {items.filter(Boolean).map((it) => (
        <Link key={it.to} to={it.to} className={`underline-item${current === it.key ? ' selected' : ''}`} aria-current={current === it.key ? 'page' : undefined}>
          <Icon name={it.icon} />
          <span>{it.label}</span>
          {it.count !== undefined && <span className="counter">{it.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export const Box = ({ header, children, className = '', footer }) => (
  <div className={`box ${className}`}>
    {header && <div className="box-header">{header}</div>}
    {children}
    {footer && <div className="box-footer">{footer}</div>}
  </div>
);

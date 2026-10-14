import { StrictMode, useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import * as A from './api.js';
import './styles.css';

// ---------- tiny router ----------
function usePath() {
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
}
function Link({ to, children, className }) {
  return (
    <a href={to} className={className} onClick={(e) => { e.preventDefault(); go(to); }}>
      {children}
    </a>
  );
}

// ---------- shared bits ----------
function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => setState({ data }), (error) => setState({ error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

function ErrorNote({ error }) {
  return error ? <p className="error" role="alert">{error.message}</p> : null;
}

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="ghost small" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Action({ label, onRun, confirm, className = '', disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <span className="action">
      <button className={className} disabled={busy || disabled} onClick={async () => {
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
      }}>{busy ? '…' : label}</button>
      {error && <span className="error inline">{error.message}</span>}
    </span>
  );
}

const fmt = (d) => new Date(d).toLocaleString();
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- auth ----------
function SignIn({ onUser, note }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onUser(mode === 'login' ? await A.login(email, password) : await A.signup(email, password));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth card">
      <h1>{mode === 'login' ? 'Sign in to Tether' : 'Create your account'}</h1>
      {note && <p className="muted">{note}</p>}
      <form onSubmit={submit}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <ErrorNote error={error} />
        <button type="submit" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
      <p className="muted switch">
        {mode === 'login' ? 'New here? ' : 'Have an account? '}
        <button className="link" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button>
      </p>
    </div>
  );
}

function CliLogin({ user }) {
  const params = new URLSearchParams(window.location.search);
  const port = params.get('port');
  const state = params.get('state');
  const [error, setError] = useState(null);
  if (!port || !state || !/^\d+$/.test(port)) return <div className="card"><p className="error">This link is incomplete. Run <code>tether login</code> again.</p></div>;
  async function authorize() {
    try {
      const { code } = await A.api('POST', '/auth/cli-code');
      window.location.href = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="auth card">
      <h1>Sign in the Tether CLI?</h1>
      <p>The <code>tether</code> command on this computer is asking to act as <strong>{user.email}</strong>.</p>
      <p className="muted">Only continue if you just ran <code>tether login</code>.</p>
      <ErrorNote error={error} />
      <div className="row"><button onClick={authorize}>Authorize CLI</button><Link to="/" className="button ghost">Cancel</Link></div>
    </div>
  );
}

// ---------- pages ----------
function Home() {
  const repos = useLoad(() => A.api('GET', '/repos'), []);
  const shared = useLoad(() => A.api('GET', '/shared'), []);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  async function create(e) {
    e.preventDefault();
    setError(null);
    try {
      await A.api('POST', '/repos', { name });
      setName('');
      repos.reload();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <>
      <section>
        <div className="section-head"><h2>Your repositories</h2></div>
        <ErrorNote error={repos.error} />
        {repos.data && !repos.data.length && <p className="muted">No repositories yet. Create one, then upload files with <code>tether manage &lt;path&gt; --repo &lt;name&gt;</code>.</p>}
        <ul className="list">
          {repos.data?.map((r) => (
            <li key={r.repoId}><Link to={`/repos/${r.repoId}`} className="item"><strong>{r.name}</strong><span className="muted mono">{r.repoId}</span></Link></li>
          ))}
        </ul>
        <form className="row" onSubmit={create}>
          <input placeholder="new-repo-name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Repository name" />
          <button type="submit">Create repository</button>
        </form>
        <ErrorNote error={error} />
      </section>
      <section>
        <h2>Shared with you</h2>
        <ErrorNote error={shared.error} />
        {shared.data && !shared.data.length && <p className="muted">Nothing yet. Editors and allowlisted users see shared artifacts here. Anyone can pull with a share ID: <code>tether pull &lt;share-id&gt;</code>.</p>}
        <ul className="list">
          {shared.data?.map((a) => (
            <li key={a.artifactId}><Link to={`/artifacts/${a.artifactId}`} className="item"><strong>{a.name}</strong><span className={`chip ${a.role}`}>{a.role}</span><span className="muted">{a.kind}{a.deleted ? ' · deleted' : ''}</span></Link></li>
          ))}
        </ul>
      </section>
    </>
  );
}

function EolRules({ repo, onSaved }) {
  const [glob, setGlob] = useState('');
  const [mode, setMode] = useState('lf');
  const save = (rules) => A.api('PATCH', `/repos/${repo.repoId}`, { eolDefaults: rules }).then(onSaved);
  return (
    <div>
      <h3>Line-ending rules</h3>
      <p className="muted">Applied to files when they are first managed. <code>.sh</code> files default to LF and <code>.bat/.cmd</code> to CRLF.</p>
      <table>
        <tbody>
          {Object.entries(repo.eolDefaults).map(([g, m]) => (
            <tr key={g}><td className="mono">{g}</td><td>{m}</td><td><Action className="ghost small" label="Remove" onRun={() => { const r = { ...repo.eolDefaults }; delete r[g]; return save(r); }} /></td></tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input placeholder="*.yml" value={glob} onChange={(e) => setGlob(e.target.value)} aria-label="Glob" />
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">{['auto', 'lf', 'crlf', 'binary'].map((m) => <option key={m}>{m}</option>)}</select>
        <Action label="Add rule" disabled={!glob} onRun={() => save({ ...repo.eolDefaults, [glob]: mode }).then(() => setGlob(''))} />
      </div>
    </div>
  );
}

function Repo({ id }) {
  const repo = useLoad(() => A.api('GET', `/repos/${id}`), [id]);
  const [to, setTo] = useState('');
  if (repo.error) return <ErrorNote error={repo.error} />;
  if (!repo.data) return <p className="muted">Loading…</p>;
  const r = repo.data;
  return (
    <>
      <p className="crumbs"><Link to="/">Repositories</Link> /</p>
      <h1>{r.name}</h1>
      <section>
        <h2>Artifacts</h2>
        {!r.artifacts.length && <p className="muted">Empty. Run <code>tether manage &lt;path&gt; --repo {r.name}</code>.</p>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th>Share ID</th><th>Visibility</th></tr></thead>
            <tbody>
              {r.artifacts.map((a) => (
                <tr key={a.artifactId} className={a.deleted ? 'deleted' : ''}>
                  <td><Link to={`/artifacts/${a.artifactId}`}>{a.name}</Link>{a.deleted && <span className="chip orphaned">deleted</span>}</td>
                  <td>{a.kind}{a.kind === 'folder' ? ` (${a.fileCount})` : ''}</td>
                  <td>v{a.version}</td>
                  <td className="mono">{a.shareId} <Copy text={a.shareId} /></td>
                  <td>{a.visibility}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card"><EolRules repo={r} onSaved={repo.reload} /></section>
      <section className="card danger-zone">
        <h3>Transfer ownership</h3>
        <p className="muted">The new owner gets full control. You stay on as an editor with delete permission.</p>
        <div className="row">
          <input type="email" placeholder="new-owner@example.com" value={to} onChange={(e) => setTo(e.target.value)} aria-label="New owner email" />
          <Action label="Transfer" disabled={!to} confirm={`Transfer "${r.name}" to ${to}?`} onRun={() => A.api('POST', `/repos/${id}/transfer`, { to }).then(() => go('/'))} />
        </div>
        <h3>Delete repository</h3>
        <p className="muted">Permanently removes every artifact and its history from the server. Copies on people's machines stay on disk but stop syncing.</p>
        <Action className="danger" label="Delete repository" confirm={`Permanently delete "${r.name}" and all history?`} onRun={() => A.api('DELETE', `/repos/${id}`).then(() => go('/'))} />
      </section>
    </>
  );
}

function Sharing({ id }) {
  const s = useLoad(() => A.api('GET', `/artifacts/${id}/sharing`), [id]);
  const [email, setEmail] = useState('');
  const [canDelete, setCanDelete] = useState(false);
  const [allow, setAllow] = useState('');
  const op = (body) => A.api('POST', `/artifacts/${id}/share`, body).then(s.reload);
  if (s.error) return <ErrorNote error={s.error} />;
  if (!s.data) return null;
  const d = s.data;
  return (
    <section className="card">
      <h2>Sharing</h2>
      <div className="share-id">
        <span className="muted">Share ID</span>
        <code className="big">{d.shareId}</code>
        <Copy text={d.shareId} />
        <Action className="ghost small" label="Rotate" confirm="Issue a new share ID? People who only have the old link lose access; editors and allowlisted people keep it." onRun={() => op({ rotate: true })} />
      </div>
      <p className="muted">Pull with <code>tether pull {d.shareId}</code></p>

      <h3>Editors</h3>
      {!d.editors.length && <p className="muted">No editors. Only you can push changes.</p>}
      <ul className="list compact">
        {d.editors.map((e) => (
          <li key={e.uid} className="item">
            <span>{e.email}</span>
            <label className="check"><input type="checkbox" checked={e.canDelete} onChange={(ev) => op({ addEditor: e.email, canDelete: ev.target.checked })} /> can delete</label>
            <span className="spacer" />
            <Action className="ghost small" label="Make viewer" onRun={() => op({ demote: e.email })} />
            <Action className="ghost small" label="Remove" onRun={() => op({ revoke: e.email })} />
          </li>
        ))}
      </ul>
      <div className="row">
        <input type="email" placeholder="editor@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Editor email" />
        <label className="check"><input type="checkbox" checked={canDelete} onChange={(e) => setCanDelete(e.target.checked)} /> can delete</label>
        <Action label="Add editor" disabled={!email} onRun={() => op({ addEditor: email, canDelete }).then(() => setEmail(''))} />
      </div>

      <h3>Who can pull</h3>
      <div className="row radio">
        <label><input type="radio" checked={d.visibility === 'link'} onChange={() => op({ visibility: 'link' })} /> Anyone with the share ID</label>
        <label><input type="radio" checked={d.visibility === 'allowlist'} onChange={() => op({ visibility: 'allowlist' })} /> Only the allowlist</label>
      </div>
      <ul className="list compact">
        {d.allowlist.map((u) => (
          <li key={u.uid} className="item"><span>{u.email}</span><span className="spacer" /><Action className="ghost small" label="Remove" onRun={() => op({ revoke: u.email })} /></li>
        ))}
      </ul>
      <div className="row">
        <input type="email" placeholder="person@example.com" value={allow} onChange={(e) => setAllow(e.target.value)} aria-label="Allowlist email" />
        <Action label="Add to allowlist" disabled={!allow} onRun={() => op({ allow: [allow] }).then(() => setAllow(''))} />
      </div>
    </section>
  );
}

function History({ id, isOwner, kind, onChange }) {
  const h = useLoad(() => A.api('GET', `/artifacts/${id}/history`), [id]);
  if (h.error) return <ErrorNote error={h.error} />;
  const list = h.data ? [...h.data].reverse() : [];
  return (
    <section>
      <h2>History</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Version</th><th>Change</th><th>By</th><th>When</th>{isOwner && kind === 'file' && <th />}</tr></thead>
          <tbody>
            {list.map((v, i) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{v.type}{v.rolledBackTo ? ` (to v${v.rolledBackTo})` : ''}{v.relPath && kind === 'folder' ? ` ${v.relPath}` : ''}{v.size !== undefined && kind === 'file' && !v.deleted ? <span className="muted"> · {bytes(v.size)}</span> : null}</td>
                <td>{v.author}</td>
                <td className="muted">{fmt(v.createdAt)}</td>
                {isOwner && kind === 'file' && <td>{i > 0 && <Action className="ghost small" label="Restore this" confirm={`Roll back to v${v.version}? Everyone receives it as a new version.`} onRun={() => A.api('POST', `/artifacts/${id}/rollback`, { toVersion: v.version }).then(() => { h.reload(); onChange(); })} />}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Artifact({ id }) {
  const a = useLoad(() => A.api('GET', `/artifacts/${id}`), [id]);
  if (a.error) return <ErrorNote error={a.error} />;
  if (!a.data) return <p className="muted">Loading…</p>;
  const { artifact: x, role, canDelete, children, folder } = a.data;
  const isOwner = role === 'owner';
  return (
    <>
      <p className="crumbs">
        {isOwner ? <Link to={`/repos/${x.repoId}`}>Repository</Link> : <Link to="/">Home</Link>} /
        {folder && <> <Link to={`/artifacts/${folder.artifactId}`}>{folder.name}</Link> /</>}
      </p>
      <h1>{x.relPath ?? x.name} {x.deleted && <span className="chip orphaned">deleted</span>}</h1>
      <p className="muted">
        {x.kind} · v{x.version} · you are <span className={`chip ${role}`}>{role}</span>
        {x.kind === 'file' && ` · ${bytes(x.size)} · eol ${x.eol}`}
      </p>
      <div className="row">
        {canDelete && !x.deleted && <Action className="danger" label="Delete for everyone" confirm="Delete for everyone? Copies stay on disk but stop syncing. The owner can restore it." onRun={() => A.api('POST', `/artifacts/${id}/delete`).then(a.reload)} />}
        {isOwner && x.deleted && x.kind === 'folder' && <Action label="Restore folder" onRun={() => A.api('POST', `/artifacts/${id}/restore`).then(a.reload)} />}
      </div>
      {children && (
        <section>
          <h2>Files</h2>
          <ul className="list compact">
            {children.sort((p, q) => p.relPath.localeCompare(q.relPath)).map((c) => (
              <li key={c.artifactId}><Link to={`/artifacts/${c.artifactId}`} className="item"><span className="mono">{c.relPath}</span><span className="muted">v{c.version} · {bytes(c.size)}</span>{c.deleted && <span className="chip orphaned">deleted</span>}</Link></li>
            ))}
          </ul>
        </section>
      )}
      {isOwner && !x.parentFolderId && <Sharing id={id} />}
      <History id={id} isOwner={isOwner} kind={x.kind} onChange={a.reload} />
    </>
  );
}

function Account({ user, onSignOut }) {
  return (
    <>
      <h1>Account</h1>
      <p>{user.email} <span className="muted mono">{user.uid}</span></p>
      <section className="card danger-zone">
        <h3>Delete account</h3>
        <p className="muted">Permanently deletes your repositories and their history from the server, and removes you from everything shared with you. Files on anyone's machine are left in place.</p>
        <Action className="danger" label="Delete my account" confirm="Permanently delete your account and all your repositories?" onRun={() => A.api('DELETE', '/me').then(onSignOut)} />
      </section>
    </>
  );
}

// ---------- shell ----------
function App() {
  const loc = usePath();
  const [user, setUser] = useState(undefined);
  useEffect(() => {
    A.restore().then(setUser);
  }, []);
  const signOut = async () => {
    await A.logout();
    setUser(null);
    go('/');
  };
  const path = loc.split('?')[0];
  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (!user) {
    return (
      <main className="center">
        <SignIn onUser={setUser} note={path === '/cli-login' ? 'Sign in to finish connecting the Tether CLI.' : null} />
      </main>
    );
  }
  let page;
  let m;
  if (path === '/cli-login') page = <CliLogin user={user} />;
  else if ((m = path.match(/^\/repos\/([\w-]+)$/))) page = <Repo id={m[1]} />;
  else if ((m = path.match(/^\/artifacts\/([\w-]+)$/))) page = <Artifact id={m[1]} />;
  else if (path === '/account') page = <Account user={user} onSignOut={signOut} />;
  else page = <Home />;
  return (
    <>
      <header>
        <Link to="/" className="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="11" cy="16" r="6" /><circle cx="21" cy="16" r="6" /></svg>Tether</Link>
        <nav>
          <Link to="/account">{user.email}</Link>
          <button className="ghost small" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <main>{page}</main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

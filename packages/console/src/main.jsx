import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as A from './api.js';
import {
  usePath, go, Link, useLoad, timeAgo, bytes, handle, Icon, Logo, Avatar, Label, Flash, ErrorFlash,
  Blankslate, Copy, Action, UnderlineNav, Box,
} from './ui.jsx';
import './styles.css';

// ======================= sign in =======================

function SignIn({ onUser, note }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const login = mode === 'login';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onUser(login ? await A.login(email, password) : await A.signup(email, password));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setError(null);
    setNotice(null);
    if (!email) return setError(new Error('Enter your email address first.'));
    try {
      await A.resetPassword(email);
      setNotice(`If ${email} has an account, a reset link is on its way.`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-logo"><Logo size={48} /></div>
      <h1 className="auth-title">{login ? 'Sign in to Tether' : 'Create your account'}</h1>
      {note && <Flash tone="accent" icon="terminal">{note}</Flash>}
      <ErrorFlash error={error} />
      {notice && <Flash tone="success" icon="check">{notice}</Flash>}
      <form className="auth-box" onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <div className="label-row">
          <label htmlFor="password">Password</label>
          {login && A.isFirebase() && <button type="button" className="link-btn" onClick={reset}>Forgot password?</button>}
        </div>
        <input id="password" className="input" type="password" autoComplete={login ? 'current-password' : 'new-password'} minLength={A.isFirebase() ? 6 : 8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Working…' : login ? 'Sign in' : 'Create account'}</button>
      </form>
      <div className="auth-switch">
        {login ? 'New to Tether? ' : 'Already have an account? '}
        <button type="button" className="link-btn" onClick={() => setMode(login ? 'signup' : 'login')}>{login ? 'Create an account' : 'Sign in'}</button>
      </div>
    </div>
  );
}

function CliLogin({ user }) {
  const params = new URLSearchParams(window.location.search);
  const port = params.get('port');
  const state = params.get('state');
  const [error, setError] = useState(null);
  if (!port || !state || !/^\d+$/.test(port)) {
    return <div className="auth-page"><Flash tone="danger">This link is incomplete. Run <code>tether login</code> again.</Flash></div>;
  }
  async function authorize() {
    try {
      const { code } = await A.api('POST', '/auth/cli-code');
      window.location.href = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-pair" aria-hidden="true"><Icon name="terminal" size={28} /><span className="pair-dots">• • •</span><Logo size={36} /></div>
      <h1 className="auth-title">Sign in the Tether CLI?</h1>
      <Box className="auth-box">
        <p>The <code>tether</code> command on this computer is asking to act as</p>
        <p className="who"><Avatar email={user.email} size={24} /> <strong>{user.email}</strong></p>
        <Flash tone="attention">Only continue if you just ran <code>tether login</code> yourself.</Flash>
        <ErrorFlash error={error} />
        <div className="row-end">
          <Link to="/" className="btn">Cancel</Link>
          <button className="btn btn-primary" onClick={authorize}>Authorize CLI</button>
        </div>
      </Box>
    </div>
  );
}

// ======================= dashboard =======================

function Dashboard({ user }) {
  const repos = useLoad(() => A.api('GET', '/repos'), []);
  const shared = useLoad(() => A.api('GET', '/shared'), []);
  const [filter, setFilter] = useState('');
  const list = (repos.data ?? []).filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="dashboard">
      <aside className="dash-side" aria-label="Your repositories">
        <div className="side-head">
          <h2>Your repositories</h2>
          <Link to="/new" className="btn btn-primary btn-sm"><Icon name="repo" />New</Link>
        </div>
        <input className="input input-sm" type="search" placeholder="Find a repository…" aria-label="Find a repository" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ErrorFlash error={repos.error} />
        <ul className="side-list">
          {list.map((r) => (
            <li key={r.repoId}>
              <Link to={`/repos/${r.repoId}`} className="side-item"><Avatar email={user.email} size={16} /><span>{handle(user.email)}/<strong>{r.name}</strong></span></Link>
            </li>
          ))}
        </ul>
        {repos.data && !repos.data.length && <p className="muted small">No repositories yet. <Link to="/new">Create one</Link> to start sharing files.</p>}
      </aside>

      <section className="dash-main">
        {repos.data && !repos.data.length && (
          <Box header={<strong>Get started</strong>} className="mb">
            <ol className="steps">
              <li><Link to="/new">Create a repository</Link> to hold the files you share.</li>
              <li>Install the CLI: <code>npm install -g tether-sync</code>, then <code>tether login</code>.</li>
              <li>Share a file or folder: <code>tether manage &lt;path&gt; --repo &lt;name&gt;</code>. It prints a share ID.</li>
              <li>Anyone with the ID runs <code>tether pull &lt;share-id&gt;</code> and gets a copy that stays in sync.</li>
            </ol>
          </Box>
        )}
        <h2 className="section-title">Shared with you</h2>
        <ErrorFlash error={shared.error} />
        {shared.data && !shared.data.length ? (
          <Box>
            <Blankslate icon="people" title="Nothing shared with you yet">
              <p>Files you are an editor of, or allowlisted for, show up here. Anyone can pull a link-shared file with <code>tether pull &lt;share-id&gt;</code>.</p>
            </Blankslate>
          </Box>
        ) : (
          <Box>
            <ul className="rows">
              {shared.data?.map((a) => (
                <li key={a.artifactId} className="row">
                  <Icon name={a.kind === 'folder' ? 'folder' : 'file'} className={a.kind === 'folder' ? 'icon-folder' : 'icon-muted'} />
                  <Link to={`/artifacts/${a.artifactId}`} className="row-title">{a.name}</Link>
                  <Label tone={a.role === 'editor' ? 'accent' : 'default'}>{a.role}</Label>
                  {a.deleted && <Label tone="danger">deleted</Label>}
                  <span className="spacer" />
                  <span className="muted small">Updated {timeAgo(a.updatedAt)}</span>
                </li>
              ))}
            </ul>
          </Box>
        )}
      </section>
    </div>
  );
}

function NewRepo({ user }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await A.api('POST', '/repos', { name });
      go(`/repos/${r.repoId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <h1 className="page-title">Create a new repository</h1>
      <p className="muted">A repository holds files and folders you share with Tether. Each one gets its own share ID.</p>
      <hr />
      <form onSubmit={create}>
        <div className="owner-row">
          <div>
            <span className="field-label">Owner</span>
            <div className="owner"><Avatar email={user.email} size={20} /> {handle(user.email)}</div>
          </div>
          <span className="slash">/</span>
          <div className="grow">
            <label className="field-label" htmlFor="repo-name">Repository name</label>
            <input id="repo-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="team-config" required autoFocus />
          </div>
        </div>
        <p className="muted small">Short and memorable. You'll use it with <code>tether manage &lt;path&gt; --repo {name || '<name>'}</code>.</p>
        <ErrorFlash error={error} />
        <hr />
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create repository'}</button>
      </form>
    </div>
  );
}

// ======================= repository =======================

function RepoHead({ repo, user }) {
  return (
    <div className="page-head">
      <div className="crumbs-title">
        <Icon name="repo" className="icon-muted" />
        <Link to="/">{handle(user.email)}</Link>
        <span className="slash">/</span>
        <Link to={`/repos/${repo.repoId}`}><strong>{repo.name}</strong></Link>
        <Label>Owner</Label>
      </div>
    </div>
  );
}

function Repo({ id, tab, user }) {
  const repo = useLoad(() => A.api('GET', `/repos/${id}`), [id]);
  if (repo.error) return <ErrorFlash error={repo.error} />;
  if (!repo.data) return <p className="muted">Loading…</p>;
  const r = repo.data;
  return (
    <>
      <RepoHead repo={r} user={user} />
      <UnderlineNav
        current={tab}
        items={[
          { key: 'artifacts', to: `/repos/${id}`, icon: 'code', label: 'Artifacts', count: r.artifacts.filter((a) => !a.deleted).length },
          { key: 'settings', to: `/repos/${id}/settings`, icon: 'gear', label: 'Settings' },
        ]}
      />
      {tab === 'settings' ? <RepoSettings repo={r} onSaved={repo.reload} /> : <RepoArtifacts repo={r} />}
    </>
  );
}

function RepoArtifacts({ repo }) {
  if (!repo.artifacts.length) {
    return (
      <Box>
        <Blankslate icon="repo" title="This repository is empty">
          <p>Share a file or folder from the CLI:</p>
          <pre className="cmd">tether manage &lt;path&gt; --repo {repo.name}</pre>
        </Blankslate>
      </Box>
    );
  }
  const live = repo.artifacts.filter((a) => !a.deleted).length;
  return (
    <Box header={<span>{live} artifact{live === 1 ? '' : 's'}{Object.keys(repo.eolDefaults).length ? ` · line-ending rules: ${Object.keys(repo.eolDefaults).join(', ')}` : ''}</span>}>
      <div className="table-wrap">
        <table className="file-table">
          <thead className="sr-only"><tr><th>Name</th><th>Version</th><th>Share ID</th><th>Access</th><th>Updated</th></tr></thead>
          <tbody>
            {repo.artifacts.map((a) => (
              <tr key={a.artifactId} className={a.deleted ? 'is-deleted' : ''}>
                <td>
                  <span className="name-cell">
                    <Icon name={a.kind === 'folder' ? 'folder' : 'file'} className={a.kind === 'folder' ? 'icon-folder' : 'icon-muted'} />
                    <Link to={`/artifacts/${a.artifactId}`}>{a.name}</Link>
                    {a.kind === 'folder' && <span className="muted small">{a.fileCount} files</span>}
                    {a.deleted && <Label tone="danger">deleted</Label>}
                  </span>
                </td>
                <td><Label>v{a.version}</Label></td>
                <td className="share-cell"><code>{a.shareId}</code> <Copy text={a.shareId} label={`Copy share ID ${a.shareId}`} /></td>
                <td className="muted small"><Icon name={a.visibility === 'link' ? 'globe' : 'lock'} /> {a.visibility === 'link' ? 'Anyone with the ID' : 'Allowlist'}</td>
                <td className="muted small nowrap">{timeAgo(a.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Box>
  );
}

function RepoSettings({ repo, onSaved }) {
  const [glob, setGlob] = useState('');
  const [mode, setMode] = useState('lf');
  const [to, setTo] = useState('');
  const save = (rules) => A.api('PATCH', `/repos/${repo.repoId}`, { eolDefaults: rules }).then(onSaved);
  return (
    <div className="settings">
      <h2 className="section-title">Line-ending rules</h2>
      <p className="muted">Applied to files when they are first managed. <code>.sh</code> files default to LF and <code>.bat</code>/<code>.cmd</code> to CRLF.</p>
      <Box>
        <ul className="rows">
          {Object.entries(repo.eolDefaults).map(([g, m]) => (
            <li key={g} className="row">
              <code>{g}</code><Label>{m}</Label><span className="spacer" />
              <Action className="btn btn-sm" label="Remove" onRun={() => { const r = { ...repo.eolDefaults }; delete r[g]; return save(r); }} />
            </li>
          ))}
          <li className="row form-row">
            <input className="input input-sm" placeholder="*.yml" value={glob} onChange={(e) => setGlob(e.target.value)} aria-label="File pattern" />
            <select className="input input-sm" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Line endings">{['auto', 'lf', 'crlf', 'binary'].map((m) => <option key={m}>{m}</option>)}</select>
            <Action className="btn btn-sm" label="Add rule" disabled={!glob} onRun={() => save({ ...repo.eolDefaults, [glob]: mode }).then(() => setGlob(''))} />
          </li>
        </ul>
      </Box>

      <h2 className="section-title danger-title">Danger Zone</h2>
      <div className="danger-box">
        <div className="danger-row">
          <div>
            <strong>Transfer ownership</strong>
            <p className="muted small">The new owner gets full control. You stay on as an editor with delete permission.</p>
            <input className="input input-sm" type="email" placeholder="new-owner@example.com" value={to} onChange={(e) => setTo(e.target.value)} aria-label="New owner email" />
          </div>
          <Action className="btn btn-danger" label="Transfer" disabled={!to} confirm={`Transfer "${repo.name}" to ${to}?`} onRun={() => A.api('POST', `/repos/${repo.repoId}/transfer`, { to }).then(() => go('/'))} />
        </div>
        <div className="danger-row">
          <div>
            <strong>Delete this repository</strong>
            <p className="muted small">Permanently removes every artifact and its history from the server. Copies on people's machines stay on disk but stop syncing.</p>
          </div>
          <Action className="btn btn-danger" label="Delete this repository" confirm={`Permanently delete "${repo.name}" and all history?`} onRun={() => A.api('DELETE', `/repos/${repo.repoId}`).then(() => go('/'))} />
        </div>
      </div>
    </div>
  );
}

// ======================= artifact =======================

const isText = (buf) => !new Uint8Array(buf.slice(0, 8192)).includes(0);

function FileView({ id, artifact, version, isOwner, onRestored }) {
  const [state, setState] = useState({});
  useEffect(() => {
    let alive = true;
    setState({});
    A.content(id, version).then(
      (buf) => alive && setState({ buf }),
      (error) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
  }, [id, version]);
  const text = useMemo(() => (state.buf && isText(state.buf) ? new TextDecoder().decode(state.buf) : null), [state.buf]);
  const lines = text?.replace(/\n$/, '').split('\n') ?? [];

  function download() {
    const url = URL.createObjectURL(new Blob([state.buf]));
    const a = Object.assign(document.createElement('a'), { href: url, download: artifact.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      {version && Number(version) !== artifact.version && (
        <Flash tone="attention" icon="history">
          Viewing v{version}. The current version is v{artifact.version}.{' '}
          {isOwner && <Action className="btn btn-sm" label={`Restore v${version}`} confirm={`Make v${version} the current version for everyone?`} onRun={() => A.api('POST', `/artifacts/${id}/rollback`, { toVersion: Number(version) }).then(onRestored)} />}
        </Flash>
      )}
      <Box
        className="blob"
        header={
          <div className="blob-head">
            <span className="muted small">{state.buf ? `${lines.length} lines · ${bytes(state.buf.byteLength)}` : bytes(artifact.size)} · v{version ?? artifact.version} · eol {artifact.eol}</span>
            <span className="spacer" />
            {state.buf && <button type="button" className="btn btn-sm" onClick={download}><Icon name="download" />Download</button>}
          </div>
        }
      >
        {state.error && <ErrorFlash error={state.error} />}
        {!state.buf && !state.error && <p className="muted pad">Loading…</p>}
        {state.buf && text === null && <p className="muted pad">Binary file not shown.</p>}
        {text !== null && state.buf && (
          <div className="code-wrap">
            <table className="code" aria-label="File content">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}><td className="ln">{i + 1}</td><td className="lc">{l || ' '}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>
    </>
  );
}

function FolderView({ id, folder, files, dir }) {
  const entries = useMemo(() => {
    const prefix = dir ? `${dir}/` : '';
    const dirs = new Map();
    const list = [];
    for (const c of files.filter((x) => !x.deleted && x.relPath.startsWith(prefix))) {
      const rest = c.relPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const d = rest.slice(0, slash);
        const cur = dirs.get(d);
        dirs.set(d, { name: d, updatedAt: cur && cur.updatedAt > c.updatedAt ? cur.updatedAt : c.updatedAt });
      } else list.push({ ...c, name: rest });
    }
    return [...[...dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ ...d, dir: true })), ...list.sort((a, b) => a.name.localeCompare(b.name))];
  }, [files, dir]);
  const parts = dir ? dir.split('/') : [];
  return (
    <Box
      header={
        <div className="blob-head">
          <span className="path-crumbs">
            <Link to={`/artifacts/${id}`}><strong>{folder.name}</strong></Link>
            {parts.map((p, i) => (
              <span key={i}> / <Link to={`/artifacts/${id}?path=${encodeURIComponent(parts.slice(0, i + 1).join('/'))}`}>{p}</Link></span>
            ))}
          </span>
          <span className="spacer" />
          <span className="muted small">{files.filter((c) => !c.deleted).length} files · v{folder.version}</span>
        </div>
      }
    >
      <ul className="rows">
        {dir && (
          <li className="row"><Icon name="folder" className="icon-folder" /><Link to={`/artifacts/${id}${parts.length > 1 ? `?path=${encodeURIComponent(parts.slice(0, -1).join('/'))}` : ''}`}>..</Link></li>
        )}
        {entries.map((e) => (
          <li key={e.dir ? `d:${e.name}` : e.artifactId} className="row">
            <Icon name={e.dir ? 'folder' : 'file'} className={e.dir ? 'icon-folder' : 'icon-muted'} />
            {e.dir ? <Link to={`/artifacts/${id}?path=${encodeURIComponent((dir ? `${dir}/` : '') + e.name)}`}>{e.name}</Link> : <Link to={`/artifacts/${e.artifactId}`}>{e.name}</Link>}
            <span className="spacer" />
            {!e.dir && <Label>v{e.version}</Label>}
            <span className="muted small nowrap">{timeAgo(e.updatedAt)}</span>
          </li>
        ))}
      </ul>
    </Box>
  );
}

const describe = (v, kind) => {
  if (v.type === 'create') return kind === 'folder' ? 'Created the folder' : 'Created';
  if (v.type === 'add') return `Added ${v.relPath}`;
  if (v.type === 'rollback') return `Restored v${v.rolledBackTo}`;
  if (v.type === 'restore') return v.rolledBackTo ? `Restored v${v.rolledBackTo} (undeleted)` : 'Restored';
  if (v.type === 'delete') return kind === 'folder' && v.relPath ? `Deleted ${v.relPath}` : 'Deleted';
  if (v.type === 'move') return `Moved to ${v.relPath}`;
  return v.type.split('+').map((t) => ({ content: 'Updated content', move: `moved to ${v.relPath}`, delete: 'deleted' })[t] ?? t).join(', ').replace(/^./, (c) => c.toUpperCase());
};

function History({ id, kind, isOwner, current, onChange }) {
  const h = useLoad(() => A.api('GET', `/artifacts/${id}/history`), [id, current]);
  if (h.error) return <ErrorFlash error={h.error} />;
  if (!h.data) return <p className="muted">Loading…</p>;
  const groups = [];
  for (const v of [...h.data].reverse()) {
    const day = new Date(v.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    if (!groups.length || groups.at(-1).day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(v);
  }
  return (
    <div className="timeline">
      {groups.map((g) => (
        <section key={g.day} className="tl-group">
          <h3 className="tl-day"><Icon name="history" /> Versions on {g.day}</h3>
          <Box>
            <ul className="rows">
              {g.items.map((v) => (
                <li key={v.version} className="row commit-row" aria-label={`v${v.version} ${describe(v, kind)}`}>
                  <div className="commit-main">
                    <div className="commit-msg">{describe(v, kind)}{v.gitCommit && <span className="muted small"> · from git <code>{v.gitCommit.slice(0, 7)}</code></span>}</div>
                    <div className="muted small"><Avatar email={v.author} size={16} /> <strong>{handle(v.author)}</strong> changed this {timeAgo(v.createdAt)}</div>
                  </div>
                  <span className="spacer" />
                  {kind === 'file' && !v.deleted && v.blob ? <Link className="btn btn-sm mono" to={`/artifacts/${id}?version=${v.version}`} aria-label={`View v${v.version}`}>v{v.version}</Link> : <span className="btn btn-sm mono is-static" aria-hidden="true">v{v.version}</span>}
                  {isOwner && kind === 'file' && v.version !== current && (
                    <Action className="btn btn-sm" label="Restore" confirm={`Roll back to v${v.version}? Everyone receives it as a new version.`} onRun={() => A.api('POST', `/artifacts/${id}/rollback`, { toVersion: v.version }).then(() => { h.reload(); onChange(); })} />
                  )}
                </li>
              ))}
            </ul>
          </Box>
        </section>
      ))}
    </div>
  );
}

function Sharing({ id }) {
  const s = useLoad(() => A.api('GET', `/artifacts/${id}/sharing`), [id]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const op = (body) => A.api('POST', `/artifacts/${id}/share`, body).then(s.reload);
  if (s.error) return <ErrorFlash error={s.error} />;
  if (!s.data) return <p className="muted">Loading…</p>;
  const d = s.data;
  const people = [
    ...d.editors.map((e) => ({ ...e, role: e.canDelete ? 'editor+delete' : 'editor' })),
    ...d.allowlist.filter((a) => !d.editors.some((e) => e.uid === a.uid)).map((a) => ({ ...a, role: 'viewer' })),
  ];
  const setPersonRole = (p, r) => (r === 'viewer' ? (p.role === 'viewer' ? null : op({ demote: p.email })) : op({ addEditor: p.email, canDelete: r === 'editor+delete' }));
  async function add() {
    if (role === 'viewer') await op({ allow: [email] });
    else await op({ addEditor: email, canDelete: role === 'editor+delete' });
    setEmail('');
  }
  return (
    <div className="settings">
      <h2 className="section-title">Share ID</h2>
      <Box className="share-box">
        <div className="share-id">
          <code className="share-code" data-testid="share-id">{d.shareId}</code>
          <Copy text={d.shareId} label="Copy share ID" />
          <span className="spacer" />
          <Action className="btn btn-sm" label="Rotate" icon="history" confirm="Issue a new share ID? People who only have the old ID lose access; editors and allowlisted people keep it." onRun={() => op({ rotate: true })} />
        </div>
        <p className="muted small">Pull with <code>tether pull {d.shareId}</code></p>
      </Box>

      <h2 className="section-title">Who can pull</h2>
      <div className="radio-cards">
        <label className={`radio-card${d.visibility === 'link' ? ' checked' : ''}`}>
          <input type="radio" name="visibility" checked={d.visibility === 'link'} onChange={() => op({ visibility: 'link' })} />
          <Icon name="globe" />
          <span><strong>Anyone with the share ID</strong><span className="muted small">Pulls as a viewer. Rotate the ID to cut off old links.</span></span>
        </label>
        <label className={`radio-card${d.visibility === 'allowlist' ? ' checked' : ''}`}>
          <input type="radio" name="visibility" checked={d.visibility === 'allowlist'} onChange={() => op({ visibility: 'allowlist' })} />
          <Icon name="lock" />
          <span><strong>Only people listed below</strong><span className="muted small">Everyone else is refused, even with the share ID.</span></span>
        </label>
      </div>

      <h2 className="section-title">Manage access</h2>
      <Box
        header={
          <div className="add-person">
            <input className="input input-sm grow" type="email" placeholder="Add people by email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address to add" />
            <select className="input input-sm" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role for new person">
              <option value="editor">Editor</option>
              <option value="editor+delete">Editor (can delete)</option>
              <option value="viewer">Viewer</option>
            </select>
            <Action className="btn btn-sm btn-primary" label="Add" disabled={!email} onRun={add} />
          </div>
        }
      >
        {!people.length ? (
          <Blankslate icon="people" title="Only you can push changes">
            <p>Editors can change the files; viewers on the list can pull even when access is restricted.</p>
          </Blankslate>
        ) : (
          <ul className="rows">
            {people.map((p) => (
              <li key={p.uid} className="row" aria-label={p.email}>
                <Avatar email={p.email} size={28} />
                <span className="person"><strong>{handle(p.email)}</strong><span className="muted small">{p.email}</span></span>
                <span className="spacer" />
                <select className="input input-sm" value={p.role} onChange={(e) => setPersonRole(p, e.target.value)} aria-label={`Role for ${p.email}`}>
                  <option value="editor">Editor</option>
                  <option value="editor+delete">Editor (can delete)</option>
                  <option value="viewer">Viewer</option>
                </select>
                <Action className="btn btn-sm btn-danger-quiet" label="Remove" onRun={() => op({ revoke: p.email })} />
              </li>
            ))}
          </ul>
        )}
      </Box>
    </div>
  );
}

function ArtifactSettings({ id, x, role, canDelete, realtime, reload }) {
  const isOwner = role === 'owner';
  return (
    <div className="settings">
      <h2 className="section-title danger-title">Danger Zone</h2>
      <div className="danger-box">
        {isOwner && realtime && !realtime.mine && (
          <div className="danger-row">
            <div><strong>End the live session</strong><p className="muted small">{realtime.email} is editing live. Ending it stops their live pushes; their local changes are kept.</p></div>
            <Action className="btn btn-danger" label="End session" confirm={`End ${realtime.email}'s live session?`} onRun={() => A.api('POST', `/artifacts/${id}/realtime`, { action: 'stop', force: true }).then(reload)} />
          </div>
        )}
        {isOwner && x.deleted && x.kind === 'folder' && (
          <div className="danger-row">
            <div><strong>Restore this folder</strong><p className="muted small">Brings the folder back for everyone.</p></div>
            <Action className="btn" label="Restore folder" onRun={() => A.api('POST', `/artifacts/${id}/restore`).then(reload)} />
          </div>
        )}
        {canDelete && !x.deleted && (
          <div className="danger-row">
            <div><strong>Delete for everyone</strong><p className="muted small">Copies stay on everyone's disk but stop syncing. The owner can restore it from the history.</p></div>
            <Action className="btn btn-danger" label="Delete for everyone" confirm="Delete for everyone? Copies stay on disk but stop syncing." onRun={() => A.api('POST', `/artifacts/${id}/delete`).then(reload)} />
          </div>
        )}
        {!canDelete && !(isOwner && x.deleted) && <div className="danger-row"><p className="muted small">You don't have permission to delete this.</p></div>}
      </div>
    </div>
  );
}

function Artifact({ id, tab, query, user }) {
  const a = useLoad(() => A.api('GET', `/artifacts/${id}`), [id]);
  const repos = useLoad(() => A.api('GET', '/repos'), []);
  if (a.error) return <ErrorFlash error={a.error} />;
  if (!a.data) return <p className="muted">Loading…</p>;
  const { artifact: x, role, canDelete, children, folder, realtime } = a.data;
  const isOwner = role === 'owner';
  const root = folder ?? x;
  const repo = repos.data?.find((r) => r.repoId === x.repoId);
  const base = `/artifacts/${id}`;
  const showSharing = isOwner && !x.parentFolderId;
  const t = tab === 'sharing' && !showSharing ? 'code' : tab;

  return (
    <>
      <div className="page-head">
        <div className="crumbs-title">
          <Icon name={x.kind === 'folder' ? 'folder' : 'file'} className={x.kind === 'folder' ? 'icon-folder' : 'icon-muted'} />
          {repo ? (
            <>
              <Link to="/">{handle(user.email)}</Link><span className="slash">/</span>
              <Link to={`/repos/${repo.repoId}`}>{repo.name}</Link><span className="slash">/</span>
            </>
          ) : null}
          {folder && <><Link to={`/artifacts/${folder.artifactId}`}>{folder.name}</Link><span className="slash">/</span></>}
          <strong>{x.relPath ?? x.name}</strong>
          <Label tone={role === 'owner' ? 'success' : role === 'editor' ? 'accent' : 'default'} title="Your access">you are {role}</Label>
          {x.deleted && <Label tone="danger">deleted</Label>}
        </div>
      </div>
      {realtime && (
        <Flash tone="attention" icon="dot">
          <span className="live-dot" aria-hidden="true" /> Being edited live by <strong>{realtime.mine ? 'you' : realtime.email}</strong> since {new Date(realtime.since).toLocaleTimeString()}.
          {!realtime.mine && ' Other edits may conflict.'}
        </Flash>
      )}
      <UnderlineNav
        current={t}
        items={[
          { key: 'code', to: base, icon: 'code', label: x.kind === 'folder' ? 'Files' : 'Code' },
          { key: 'history', to: `${base}/history`, icon: 'history', label: 'History', count: x.version },
          showSharing && { key: 'sharing', to: `${base}/sharing`, icon: 'people', label: 'Sharing' },
          { key: 'settings', to: `${base}/settings`, icon: 'gear', label: 'Settings' },
        ]}
      />
      <div className="with-aside">
        <div className="main-col">
          {t === 'history' && <History id={id} kind={x.kind} isOwner={isOwner} current={x.version} onChange={a.reload} />}
          {t === 'sharing' && <Sharing id={id} />}
          {t === 'settings' && <ArtifactSettings id={id} x={x} role={role} canDelete={canDelete} realtime={realtime} reload={a.reload} />}
          {t === 'code' && x.kind === 'folder' && <FolderView id={id} folder={x} files={children} dir={query.get('path') ?? ''} />}
          {t === 'code' && x.kind === 'file' && !x.deleted && <FileView id={id} artifact={x} version={query.get('version')} isOwner={isOwner} onRestored={() => { a.reload(); go(base); }} />}
          {t === 'code' && x.kind === 'file' && x.deleted && <Box><Blankslate icon="trash" title="This file was deleted">{isOwner ? <p>Restore it from the <Link to={`${base}/history`}>history</Link>.</p> : <p>Only the owner can restore it.</p>}</Blankslate></Box>}
        </div>
        <aside className="aside-col" aria-label="About">
          <h2 className="aside-title">About</h2>
          <p className="muted small">{x.kind === 'folder' ? 'A shared folder. Every file inside is kept in sync.' : 'A shared file, kept identical everywhere it is pulled.'}</p>
          <ul className="facts">
            <li><Icon name="history" /> v{x.version} · updated {timeAgo(x.updatedAt)}</li>
            {x.kind === 'file' && <li><Icon name="file" /> {bytes(x.size)} · line endings {x.eol}</li>}
            {x.gitCommit && <li><Icon name="code" /> from git <code>{x.gitCommit.slice(0, 7)}</code></li>}
            {isOwner && root.shareId && <li><Icon name="link" /> <code>{root.shareId}</code> <Copy text={root.shareId} label="Copy share ID" /></li>}
          </ul>
          {isOwner && root.shareId && (
            <>
              <h2 className="aside-title">Pull it</h2>
              <pre className="cmd small">tether pull {root.shareId}</pre>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

// ======================= account =======================

function Account({ user, onSignOut }) {
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        <div className="settings-user"><Avatar email={user.email} size={32} /><span><strong>{handle(user.email)}</strong><span className="muted small">Your personal account</span></span></div>
        <a className="settings-link selected" href="#profile">Profile</a>
        <a className="settings-link" href="#cli">Command line</a>
        <a className="settings-link danger-link" href="#danger">Danger zone</a>
      </nav>
      <div className="settings-main">
        <h1 className="page-title" id="profile">Account</h1>
        <hr />
        <div className="profile">
          <Avatar email={user.email} size={72} />
          <div>
            <div><strong>{user.email}</strong></div>
            <div className="muted small mono">{user.uid}</div>
            <div className="muted small">Signed in with {A.isFirebase() ? 'Firebase' : 'a local account'}</div>
          </div>
        </div>
        <h2 className="section-title" id="cli">Command line</h2>
        <Box>
          <div className="pad">
            <p>Install the CLI and sign it in to this account:</p>
            <pre className="cmd">npm install -g tether-sync{'\n'}tether login</pre>
            <p className="muted small">Keep it current with <code>tether update</code>.</p>
          </div>
        </Box>
        <h2 className="section-title danger-title" id="danger">Danger Zone</h2>
        <div className="danger-box">
          <div className="danger-row">
            <div><strong>Delete your account</strong><p className="muted small">Permanently deletes your repositories and their history, and removes you from everything shared with you. Files on anyone's machine are left in place.</p></div>
            <Action className="btn btn-danger" label="Delete my account" confirm="Permanently delete your account and all your repositories?" onRun={() => A.api('DELETE', '/me').then(onSignOut)} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ======================= shell =======================

function Header({ user, onSignOut }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="Tether home"><Logo size={30} /><span>Tether</span></Link>
      <span className="spacer" />
      <Link to="/new" className="header-btn" aria-label="New repository" title="New repository"><Icon name="plus" /></Link>
      <details className="menu">
        <summary aria-label="Account menu" role="button"><Avatar email={user.email} size={26} /></summary>
        <div className="menu-list">
          <div className="menu-head">Signed in as <strong>{user.email}</strong></div>
          <Link to="/" className="menu-item">Your repositories</Link>
          <Link to="/account" className="menu-item">Account settings</Link>
          <button type="button" className="menu-item" onClick={onSignOut}><Icon name="signout" /> Sign out</button>
        </div>
      </details>
    </header>
  );
}

function App() {
  const loc = usePath();
  const [user, setUser] = useState(undefined);
  useEffect(() => {
    A.restore().then(setUser);
  }, []);
  useEffect(() => {
    document.querySelectorAll('details.menu[open]').forEach((d) => d.removeAttribute('open'));
  }, [loc]);
  const signOut = async () => {
    await A.logout();
    setUser(null);
    go('/');
  };
  const [path, search] = loc.split('?');
  const query = new URLSearchParams(search ?? '');
  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (!user) {
    return <main className="center"><SignIn onUser={setUser} note={path === '/cli-login' ? 'Sign in to finish connecting the Tether CLI.' : null} /></main>;
  }
  let page;
  let m;
  if (path === '/cli-login') page = <CliLogin user={user} />;
  else if (path === '/new') page = <NewRepo user={user} />;
  else if ((m = path.match(/^\/repos\/([\w-]+)(?:\/(settings))?$/))) page = <Repo id={m[1]} tab={m[2] ?? 'artifacts'} user={user} />;
  else if ((m = path.match(/^\/artifacts\/([\w-]+)(?:\/(history|sharing|settings))?$/))) page = <Artifact id={m[1]} tab={m[2] ?? 'code'} query={query} user={user} />;
  else if (path === '/account') page = <Account user={user} onSignOut={signOut} />;
  else page = <Dashboard user={user} />;
  return (
    <>
      <Header user={user} onSignOut={signOut} />
      <main className="container">{page}</main>
      <footer className="footer"><Logo size={18} /> <span>Tether</span> <span className="muted">·</span> <a href="https://www.npmjs.com/package/tether-sync">CLI on npm</a> <span className="muted">·</span> <a href="https://github.com/SaiEthihasChanda/Tether">Source</a></footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

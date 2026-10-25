// The app's pages: sign in, your files and their details, collections, activity, settings.
import { useEffect, useRef, useState } from 'react';
import { t, useLoad, describe, canEdit, timeAgo, baseName, friendlyDir, ROLE, historyText, errorText } from './lib.js';
import { Icon, Logo, Chip, Button, Modal, Confirm, Copy, Empty, useToast } from './ui.jsx';
import { LocateFlow } from './flows.jsx';

// ================================================================ sign in
export function SignIn({ onSignedIn }) {
  const [mode, setMode] = useState(null); // null | 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [waiting, setWaiting] = useState(false);
  const toast = useToast();
  return (
    <div className="signin">
      <div className="signin-card">
        <Logo size={56} />
        <h1>Welcome to Tether</h1>
        <p className="muted">Keep a file the same everywhere it lives: on your computers and your team's. Sign in to start.</p>
        {!mode ? (
          <>
            <Button kind="primary" onClick={async () => {
              setWaiting(true);
              try { await t.loginWithBrowser(); onSignedIn(); } catch (e) { toast(errorText(e), 'error'); } finally { setWaiting(false); }
            }}>{waiting ? 'Finish signing in in your browser…' : 'Sign in with your browser'}</Button>
            <button className="link" onClick={() => setMode('signin')}>Use email and password instead</button>
          </>
        ) : (
          <form className="signin-form" onSubmit={(e) => e.preventDefault()}>
            <label className="field"><span className="label">Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
            <label className="field"><span className="label">Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>
            <Button kind="primary" type="submit" disabled={!email || password.length < 6} onClick={async () => {
              await t.call('login.password', { email, password, signup: mode === 'signup' });
              onSignedIn();
            }}>{mode === 'signup' ? 'Create account' : 'Sign in'}</Button>
            <button type="button" className="link" onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
              {mode === 'signup' ? 'I already have an account' : "I don't have an account yet"}
            </button>
            <button type="button" className="link" onClick={() => setMode(null)}>Back</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ================================================================ your files
export function Files({ status, onOpen, onShare, onGet, onAction }) {
  const roots = status.instances.filter((i) => !i.folderInstanceId);
  const live = roots.filter((i) => i.mode !== 'orphaned');
  const gone = roots.filter((i) => i.mode === 'orphaned');
  const [showGone, setShowGone] = useState(false);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Your files</h1>
          <p className="muted">{live.length ? `${live.length} item${live.length === 1 ? '' : 's'} kept in sync on this computer.` : 'Share something, or open a share code someone sent you.'}</p>
        </div>
        <div className="row">
          <Button icon="download" onClick={onGet}>Open a share code</Button>
          <Button kind="primary" icon="share" onClick={() => onShare()}>Share a file or folder</Button>
        </div>
      </header>
      {status.offline && <div className="banner banner-warn"><Icon name="alert" /> Offline: Tether keeps protecting your files and catches up when you are back online.</div>}
      {!live.length ? (
        <Empty icon="share" title="Nothing here yet">
          <p>Drag a file or folder onto this window to share it, or use the buttons above.</p>
          <p className="small">You can also right-click a file in File Explorer and choose <strong>Tether › Share with Tether</strong>.</p>
        </Empty>
      ) : (
        <ul className="items" aria-label="Your files">
          {live.map((i) => <ItemRow key={i.instanceId} item={i} status={status} onOpen={onOpen} onAction={onAction} />)}
        </ul>
      )}
      {gone.length > 0 && (
        <div className="gone">
          <button className="link" onClick={() => setShowGone(!showGone)}>{showGone ? 'Hide' : 'Show'} {gone.length} item{gone.length === 1 ? '' : 's'} no longer synced</button>
          {showGone && <ul className="items">{gone.map((i) => <ItemRow key={i.instanceId} item={i} status={status} onOpen={onOpen} onAction={onAction} />)}</ul>}
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL = { edit: ['Make changes', 'edit'], done: ['Done', 'check'], track: ['Sync again', 'play'], find: ['Find it', 'search'] };

function ItemRow({ item, status, onOpen, onAction }) {
  const d = describe(item);
  const kids = status.instances.filter((c) => c.folderInstanceId === item.instanceId);
  const kidNote = item.kind === 'folder' ? `${kids.length} file${kids.length === 1 ? '' : 's'} · ` : '';
  return (
    <li className="item" aria-label={baseName(item.path)}>
      <button className="item-main" onClick={() => onOpen(item.instanceId)}>
        <Icon name={item.kind === 'folder' ? 'folder' : 'file'} size={22} className="item-icon" />
        <span className="item-text">
          <strong>{baseName(item.path)}</strong>
          <span className="muted small">{kidNote}{friendlyDir(item.path)}{item.liveBy ? ` · being changed live by ${item.liveBy.email}` : ''}</span>
        </span>
      </button>
      <Chip tone={d.tone}>{d.label}</Chip>
      {d.action && <Button small kind={d.action === 'done' ? 'primary' : 'secondary'} icon={ACTION_LABEL[d.action][1]} onClick={() => onAction(d.action, item)}>{ACTION_LABEL[d.action][0]}</Button>}
    </li>
  );
}

// ================================================================ one item
export function Detail({ item, status, tab, setTab, onBack, onAction, reloadStatus, scanRoots }) {
  const d = describe(item);
  const info = useLoad(() => (item.mode === 'orphaned' ? Promise.resolve(null) : t.call('info', { ref: item.artifactId })), [item.artifactId, item.version]);
  const isOwner = item.role === 'owner';
  const kids = status.instances.filter((c) => c.folderInstanceId === item.instanceId);
  const tabs = [['overview', 'Overview', 'file'], ['history', 'History', 'history'], ...(isOwner ? [['people', 'People', 'people'], ['devices', 'Devices', 'device']] : []), ['more', 'More', 'gear']];
  const current = tabs.some(([k]) => k === tab) ? tab : 'overview';
  return (
    <div className="page">
      <button className="back link" onClick={onBack}><Icon name="back" size={16} /> Your files</button>
      <header className="detail-head">
        <Icon name={item.kind === 'folder' ? 'folder' : 'file'} size={34} className="item-icon" />
        <div className="grow">
          <h1>{baseName(item.path)}</h1>
          <p className="muted small" title={item.path}>{item.path}</p>
        </div>
        <Button icon="open" onClick={() => t.open(item.path)}>Open</Button>
        <Button onClick={() => t.reveal(item.path)}>Show in folder</Button>
      </header>
      <nav className="tabs" role="tablist">
        {tabs.map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={current === k} className={current === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={icon} size={16} /> {label}</button>
        ))}
      </nav>
      {current === 'overview' && <Overview item={item} d={d} info={info.data} kids={kids} onAction={onAction} reloadStatus={reloadStatus} scanRoots={scanRoots} />}
      {current === 'history' && <History item={item} isOwner={isOwner} reloadStatus={reloadStatus} />}
      {current === 'people' && <People item={item} />}
      {current === 'devices' && <Devices item={item} />}
      {current === 'more' && <More item={item} info={info.data} reload={() => { info.reload(); reloadStatus(); }} onAction={onAction} />}
    </div>
  );
}

function Overview({ item, d, info, kids, onAction, reloadStatus, scanRoots }) {
  const [locate, setLocate] = useState(false);
  const toast = useToast();
  const shareId = info?.artifact?.shareId;
  return (
    <div className="stack">
      <section className={`status-card tone-${d.tone}`}>
        <div className="grow">
          <Chip tone={d.tone}>{d.label}</Chip>
          <p>{d.text}</p>
          {item.liveBy && <p className="muted"><Icon name="live" size={14} /> {item.liveBy.email} is changing it live right now. Their saves keep arriving.</p>}
        </div>
        <div className="row wrap">
          {d.action === 'edit' && <Button kind="primary" icon="edit" onClick={() => onAction('edit', item)}>Make changes</Button>}
          {d.action === 'edit' && item.kind === 'file' && !item.liveBy && <Button icon="live" onClick={() => onAction('live', item)}>Edit live</Button>}
          {d.action === 'done' && <Button kind="primary" icon="check" onClick={() => onAction('done', item)}>Done</Button>}
          {d.action === 'track' && <Button kind="primary" icon="play" onClick={() => onAction('track', item)}>Sync again</Button>}
          {d.action === 'find' && <Button kind="primary" icon="search" onClick={() => setLocate(true)}>Find it</Button>}
        </div>
      </section>
      <dl className="facts">
        <div><dt>Your access</dt><dd>{ROLE[item.role] ?? '—'}</dd></div>
        <div><dt>Version</dt><dd>{item.version}{info?.artifact?.updatedAt ? ` · changed ${timeAgo(info.artifact.updatedAt)}` : ''}</dd></div>
        {shareId && <div><dt>Share code</dt><dd className="row"><code data-testid="detail-share-code">{shareId}</code><Copy text={shareId} label="Copy" /></dd></div>}
        {item.gitRoot && <div><dt>Git</dt><dd><GitMode item={item} reloadStatus={reloadStatus} /></dd></div>}
      </dl>
      {item.kind === 'folder' && (
        <section>
          <h2 className="h2">Files in this folder</h2>
          <ul className="kids">
            {kids.map((k) => { const kd = describe(k); return <li key={k.instanceId}><Icon name="file" size={16} /> <span className="grow">{k.relPath}</span> <Chip tone={kd.tone}>{kd.label}</Chip></li>; })}
          </ul>
          {item.role === 'owner' && item.mode !== 'orphaned' && (
            <Button small icon="plus" onClick={async () => {
              const f = await t.pick({ kind: 'file', title: 'Choose a new file inside this folder', defaultPath: item.path });
              if (!f) return;
              const r = await t.call('add', { path: f });
              toast(`${r.relPath} is now part of ${baseName(item.path)}.`, 'good');
              reloadStatus();
            }}>Add a new file</Button>
          )}
        </section>
      )}
      {locate && <LocateFlow item={item} scanRoots={scanRoots} onClose={() => setLocate(false)} onDone={reloadStatus} />}
    </div>
  );
}

function GitMode({ item, reloadStatus }) {
  const mode = item.gitMode ?? 'keep';
  return (
    <select aria-label="When git changes it" value={mode} onChange={async (e) => { await t.call('git.mode', { path: item.path, mode: e.target.value }); reloadStatus(); }}>
      <option value="keep">Keep Tether's version when git changes it</option>
      <option value="follow" disabled={!canEdit(item)}>Accept git's changes and share them</option>
    </select>
  );
}

function History({ item, isOwner, reloadStatus }) {
  const h = useLoad(() => t.call('history', { ref: item.artifactId }), [item.artifactId, item.version]);
  const [ask, setAsk] = useState(null);
  const toast = useToast();
  if (h.error) return <p className="error">{errorText(h.error)}</p>;
  if (!h.data) return <p className="muted">Loading…</p>;
  const list = [...h.data].reverse();
  return (
    <>
      <p className="muted">Every version is kept. {isOwner ? 'You can go back to any of them; that becomes a new version for everyone, so nothing is lost.' : 'The owner can bring back an earlier version.'}</p>
      <ul className="history">
        {list.map((v, n) => (
          <li key={v.version} aria-label={`Version ${v.version}`}>
            <span className="ver">v{v.version}</span>
            <span className="grow"><strong>{historyText(v)}</strong><span className="muted small">{v.author} · {new Date(v.createdAt).toLocaleString()}</span></span>
            {n === 0 ? <Chip tone="good">Current</Chip> : isOwner && item.kind === 'file' && <Button small icon="history" onClick={() => setAsk(v)}>Go back to this</Button>}
          </li>
        ))}
      </ul>
      {ask && <Confirm title={`Go back to version ${ask.version}?`} text="Everyone gets this earlier version. The current version stays in the history." yes="Go back"
        onYes={async () => { const r = await t.call('rollback', { ref: item.artifactId, toVersion: ask.version }); toast(`Now on version ${r.version}.`, 'good'); h.reload(); reloadStatus(); }}
        onClose={() => setAsk(null)} />}
    </>
  );
}

function People({ item }) {
  const s = useLoad(() => t.call('share', { ref: item.artifactId }), [item.artifactId]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [ask, setAsk] = useState(null);
  const op = async (o) => { await t.call('share', { ref: item.artifactId, op: o }); await s.reload(); };
  if (s.error) return <p className="error">{errorText(s.error)}</p>;
  if (!s.data) return <p className="muted">Loading…</p>;
  const d = s.data;
  const people = [
    ...d.editors.map((e) => ({ ...e, role: e.canDelete ? 'editor+delete' : 'editor' })),
    ...d.allowlist.filter((a) => !d.editors.some((e) => e.uid === a.uid)).map((a) => ({ ...a, role: 'viewer' })),
  ];
  return (
    <div className="stack">
      <section className="card">
        <h2 className="h2">Share code</h2>
        <div className="share-code"><code>{d.shareId}</code><Copy text={d.shareId} label="Copy code" />
          <Button small icon="refresh" onClick={() => setAsk('rotate')}>Make a new code</Button></div>
      </section>
      <section className="card">
        <h2 className="h2">Who can get it</h2>
        <div className="choices">
          <label className={`choice${d.visibility === 'link' ? ' on' : ''}`}><input type="radio" name="vis" checked={d.visibility === 'link'} onChange={() => op({ visibility: 'link' })} />
            <span><strong>Anyone with the share code</strong><span className="muted">They get a view-only copy.</span></span></label>
          <label className={`choice${d.visibility === 'allowlist' ? ' on' : ''}`}><input type="radio" name="vis" checked={d.visibility === 'allowlist'} onChange={() => op({ visibility: 'allowlist' })} />
            <span><strong>Only the people listed below</strong><span className="muted">Everyone else is refused, even with the code.</span></span></label>
        </div>
      </section>
      <section className="card">
        <h2 className="h2">People</h2>
        <form className="row" onSubmit={(e) => e.preventDefault()}>
          <input className="grow" type="email" placeholder="Add someone by email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address to add" />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Access for the new person">
            <option value="editor">Can edit</option><option value="editor+delete">Can edit and delete</option><option value="viewer">Can view</option>
          </select>
          <Button kind="primary" type="submit" disabled={!email} onClick={async () => {
            await op(role === 'viewer' ? { allow: [email] } : { addEditor: email, canDelete: role === 'editor+delete' });
            setEmail('');
          }}>Add</Button>
        </form>
        {!people.length ? <p className="muted">Only you can change it. Add people who should be able to edit, or viewers when access is restricted.</p> : (
          <ul className="people">
            {people.map((p) => (
              <li key={p.uid} aria-label={p.email}>
                <Icon name="user" /><span className="grow">{p.email}</span>
                <select aria-label={`Access for ${p.email}`} value={p.role} onChange={(e) => {
                  const r = e.target.value;
                  op(r === 'viewer' ? { demote: p.email } : { addEditor: p.email, canDelete: r === 'editor+delete' });
                }}>
                  <option value="editor">Can edit</option><option value="editor+delete">Can edit and delete</option><option value="viewer">Can view</option>
                </select>
                <Button small kind="danger-quiet" onClick={() => setAsk({ remove: p.email })}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {ask === 'rotate' && <Confirm title="Make a new share code?" text="The old code stops working. People who got it only through the code lose access; people listed here keep it." yes="Make a new code" onYes={() => op({ rotate: true })} onClose={() => setAsk(null)} />}
      {ask?.remove && <Confirm danger title={`Remove ${ask.remove}?`} text="They lose access. Their copy stays on their computer but stops syncing." yes="Remove" onYes={() => op({ revoke: ask.remove })} onClose={() => setAsk(null)} />}
    </div>
  );
}

const PLATFORM = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
function Devices({ item }) {
  const u = useLoad(() => t.call('usage', { ref: item.artifactId }), [item.artifactId], 10000);
  const [ask, setAsk] = useState(null);
  const stop = async (body) => { await t.call('unmanageFor', { ref: item.artifactId, ...body }); await u.reload(); };
  if (u.error) return <p className="error">{errorText(u.error)}</p>;
  if (!u.data) return <p className="muted">Loading…</p>;
  const d = u.data;
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  return (
    <div className="stack">
      <p><strong>{n(d.copies, 'copy', 'copies')}</strong> on <strong>{n(d.devices, 'device', 'devices')}</strong> across <strong>{n(d.accounts.length, 'person', 'people')}</strong>.</p>
      <p className="muted small">Computers running Tether 0.7 or newer show up here. Where the file is kept on their computer is never shared. Stopping sync doesn't remove anyone's access; they can sync again themselves.</p>
      {d.accounts.map((a) => (
        <section key={a.uid} className="card">
          <header className="row">
            <Icon name="user" /><strong className="grow">{a.you ? 'You' : a.email}</strong><Chip tone={a.role === 'owner' ? 'good' : a.role === 'editor' ? 'accent' : 'muted'}>{ROLE[a.role]}</Chip>
            {!a.you && a.devices.some((dv) => dv.copies.some((c) => c.mode !== 'unmanaged' && !c.pending)) && <Button small kind="danger-quiet" onClick={() => setAsk({ uid: a.uid, who: a.email })}>Stop syncing for {a.email.split('@')[0]}</Button>}
          </header>
          <ul className="devices">
            {a.devices.map((dv) => {
              const live = dv.copies.filter((c) => c.mode !== 'unmanaged' && !c.pending);
              return (
                <li key={dv.deviceId} aria-label={`${a.email} on ${dv.name}`}>
                  <Icon name="device" />
                  <span className="grow"><strong>{dv.name}</strong><span className="muted small">{PLATFORM[dv.platform] ?? dv.platform} · seen {timeAgo(dv.seenAt)}</span></span>
                  {dv.copies.map((c) => <Chip key={c.instanceId} tone={c.pending ? 'warn' : c.mode === 'unmanaged' ? 'muted' : c.mode === 'editing' ? 'accent' : 'good'}>{c.pending ? 'Stopping…' : c.mode === 'unmanaged' ? 'Not syncing' : c.mode === 'editing' ? 'Making changes' : 'In sync'}</Chip>)}
                  {!a.you && live.length > 0 && <Button small onClick={() => setAsk({ instanceIds: live.map((c) => c.instanceId), who: `${a.email} on ${dv.name}` })}>Stop syncing here</Button>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {ask && <Confirm title={`Stop syncing for ${ask.who}?`} text="Their file stays as it is on their computer and they keep access. They can sync again themselves." yes="Stop syncing"
        onYes={() => stop(ask.uid ? { uid: ask.uid } : { instanceIds: ask.instanceIds })} onClose={() => setAsk(null)} />}
    </div>
  );
}

function More({ item, info, reload, onAction }) {
  const [ask, setAsk] = useState(null);
  const toast = useToast();
  const deleted = info?.artifact?.deleted;
  return (
    <div className="stack">
      {item.mode === 'normal' || item.mode === 'editing' ? (
        <section className="card row">
          <div className="grow"><strong>Stop syncing it on this computer</strong><p className="muted small">Your copy stays as it is. Nothing changes for anyone else. You can sync again later.</p></div>
          <Button onClick={() => onAction('unmanage', item)}>Stop syncing</Button>
        </section>
      ) : null}
      {info?.realtime && !info.realtime.mine && item.role === 'owner' && (
        <section className="card row">
          <div className="grow"><strong>End {info.realtime.email}'s live editing</strong><p className="muted small">Their live saves stop; the changes they made so far are kept.</p></div>
          <Button onClick={async () => { await t.call('endRealtime', { ref: item.artifactId }); toast('Live editing ended.', 'good'); reload(); }}>End live editing</Button>
        </section>
      )}
      {item.role === 'owner' && deleted && item.kind === 'folder' && (
        <section className="card row">
          <div className="grow"><strong>Bring this folder back</strong><p className="muted small">It is restored for everyone.</p></div>
          <Button onClick={async () => { await t.call('restoreFolder', { ref: item.artifactId }); reload(); }}>Bring back</Button>
        </section>
      )}
      {item.canDelete && !deleted && item.mode !== 'orphaned' && (
        <section className="card card-danger row">
          <div className="grow"><strong>Delete it for everyone</strong><p className="muted small">Everyone's copy stays on their computer but stops syncing. The owner can bring it back from the history.</p></div>
          <Button kind="danger" icon="trash" onClick={() => setAsk(true)}>Delete for everyone</Button>
        </section>
      )}
      {ask && <Confirm danger title={`Delete ${baseName(item.path)} for everyone?`} text="Copies stay on everyone's computer but stop syncing." yes="Delete for everyone"
        onYes={async () => { await t.call('delete', { ref: item.artifactId }); toast('Deleted for everyone.', 'good'); reload(); }} onClose={() => setAsk(null)} />}
    </div>
  );
}

// ================================================================ collections
export function Collections() {
  const repos = useLoad(() => t.call('repo.list'), []);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  if (repos.error) return <div className="page"><p className="error">{errorText(repos.error)}</p></div>;
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Collections</h1><p className="muted">Collections group the files and folders you share. Most people need only one.</p></div>
        <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New collection</Button>
      </header>
      {!repos.data ? <p className="muted">Loading…</p> : !repos.data.length ? (
        <Empty icon="box" title="No collections yet">One is created for you the first time you share something.</Empty>
      ) : (
        <ul className="items">
          {repos.data.map((r) => (
            <li key={r.repoId} className="item" aria-label={r.name}>
              <button className="item-main" onClick={() => setOpen(r)}><Icon name="box" size={22} className="item-icon" /><span className="item-text"><strong>{r.name}</strong><span className="muted small">Created {timeAgo(r.createdAt)}</span></span></button>
              <Button small onClick={() => setOpen(r)}>Manage</Button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <Modal title="New collection" onClose={() => setCreating(false)} footer={<>
          <Button onClick={() => setCreating(false)}>Cancel</Button>
          <Button kind="primary" disabled={!name.trim()} onClick={async () => { await t.call('repo.create', { name: name.trim() }); setCreating(false); setName(''); repos.reload(); }}>Create</Button>
        </>}>
          <label className="field"><span className="label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team settings" /></label>
        </Modal>
      )}
      {open && <CollectionDialog repo={open} onClose={() => { setOpen(null); repos.reload(); }} />}
    </div>
  );
}

function CollectionDialog({ repo, onClose }) {
  const r = useLoad(() => t.call('repo.show', { ref: repo.repoId }), [repo.repoId]);
  const [name, setName] = useState(repo.name);
  const [to, setTo] = useState('');
  const [ask, setAsk] = useState(null);
  const [glob, setGlob] = useState('');
  const [eol, setEol] = useState('lf');
  const toast = useToast();
  const rules = Object.entries(r.data?.eolDefaults ?? {});
  return (
    <Modal wide title={repo.name} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Close</Button>}>
      <section className="stack">
        <h3 className="h3">What's in it</h3>
        {!r.data ? <p className="muted">Loading…</p> : !r.data.artifacts.length ? <p className="muted">Nothing shared in this collection yet.</p> : (
          <ul className="kids">
            {r.data.artifacts.map((a) => (
              <li key={a.artifactId}><Icon name={a.kind === 'folder' ? 'folder' : 'file'} size={16} /><span className="grow">{a.name}{a.deleted ? ' (deleted)' : ''}</span><code>{a.shareId}</code><Copy text={a.shareId} label="Copy code" /></li>
            ))}
          </ul>
        )}
        <h3 className="h3">Name</h3>
        <div className="row"><input className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Collection name" />
          <Button disabled={!name.trim() || name === repo.name} onClick={async () => { await t.call('repo.rename', { ref: repo.repoId, name: name.trim() }); toast('Renamed.', 'good'); }}>Rename</Button></div>
        <details>
          <summary>Line endings for new files (advanced)</summary>
          <p className="muted small">Text files usually keep each computer's line endings ("auto"). Set a rule if a file type must always use one style.</p>
          <ul className="kids">{rules.map(([g, m]) => <li key={g}><code className="grow">{g}</code><span>{m}</span><Button small onClick={async () => { await t.call('repo.eol', { ref: repo.repoId, glob: g, mode: 'unset' }); r.reload(); }}>Remove</Button></li>)}</ul>
          <div className="row"><input placeholder="e.g. *.sh" value={glob} onChange={(e) => setGlob(e.target.value)} aria-label="File pattern" />
            <select value={eol} onChange={(e) => setEol(e.target.value)} aria-label="Line endings"><option value="auto">auto</option><option value="lf">LF (Linux, macOS)</option><option value="crlf">CRLF (Windows)</option><option value="binary">binary (never change)</option></select>
            <Button disabled={!glob} onClick={async () => { await t.call('repo.eol', { ref: repo.repoId, glob, mode: eol }); setGlob(''); r.reload(); }}>Add rule</Button></div>
        </details>
        <h3 className="h3">Give it to someone else</h3>
        <div className="row"><input className="grow" type="email" placeholder="Their email" value={to} onChange={(e) => setTo(e.target.value)} aria-label="New owner email" />
          <Button disabled={!to} onClick={() => setAsk('transfer')}>Transfer</Button></div>
        <section className="card card-danger row">
          <div className="grow"><strong>Delete this collection</strong><p className="muted small">Everything in it and its history is deleted for everyone. Copies stay on people's computers but stop syncing. This can't be undone.</p></div>
          <Button kind="danger" icon="trash" onClick={() => setAsk('delete')}>Delete</Button>
        </section>
      </section>
      {ask === 'transfer' && <Confirm title={`Transfer to ${to}?`} text="They become the owner of everything in it. You stay on as an editor who can delete." yes="Transfer"
        onYes={async () => { await t.call('repo.transfer', { ref: repo.repoId, to }); toast(`Transferred to ${to}.`, 'good'); onClose(); }} onClose={() => setAsk(null)} />}
      {ask === 'delete' && <Confirm danger title={`Delete ${repo.name}?`} text="Everything in it and its history is deleted for everyone. This can't be undone." yes="Delete for everyone"
        onYes={async () => { await t.call('repo.delete', { ref: repo.repoId }); toast('Collection deleted.', 'good'); onClose(); }} onClose={() => setAsk(null)} />}
    </Modal>
  );
}

// ================================================================ activity
export function Activity() {
  const log = useLoad(() => t.call('log', { lines: 300 }), [], 4000);
  const lines = (log.data ?? []).slice().reverse().map((l) => {
    const m = l.match(/^(\S+)\s(.*)$/);
    return m ? { at: m[1], text: m[2].replace(/C:\\Users\\[^\\]+\\/g, '').replace(/`tether ([a-z]+)[^`]*`/g, '"$1"') } : { at: '', text: l };
  }).filter((l) => !/^\s+at /.test(l.text));
  return (
    <div className="page">
      <header className="page-head"><div><h1>Activity</h1><p className="muted">What Tether has done recently on this computer.</p></div>
        <Button icon="refresh" onClick={() => t.call('sync').then(log.reload)}>Sync now</Button></header>
      <ul className="activity">
        {lines.map((l, n) => <li key={n}><time className="muted small">{l.at ? new Date(l.at).toLocaleString() : ''}</time><span>{l.text}</span></li>)}
      </ul>
    </div>
  );
}

// ================================================================ settings
export function Settings({ status, reloadStatus, onSignedOut }) {
  const cfg = useLoad(() => t.call('config.get'), []);
  const app = useLoad(() => t.info(), [], 5000);
  const toast = useToast();
  const [deviceName, setDeviceName] = useState('');
  const [server, setServer] = useState('');
  const [tick, setTick] = useState('');
  const [quit, setQuit] = useState(false);
  const filled = useRef(false);
  useEffect(() => {
    if (!cfg.data || filled.current) return;
    filled.current = true;
    // fill the fields once, and only those nobody has typed into yet
    setDeviceName((cur) => cur || (cfg.data.deviceName ?? ''));
    setServer((cur) => cur || (cfg.data.server ?? ''));
    setTick((cur) => cur || String(cfg.data.tickSeconds ?? 30));
  }, [cfg.data]);
  const set = async (key, value, msg = 'Saved.') => { await t.call('config.set', { key, value }); await cfg.reload(); toast(msg, 'good'); };
  const a = app.data;
  const up = a?.update ?? {};
  return (
    <div className="page settings">
      <header className="page-head"><div><h1>Settings</h1></div></header>
      <section className="card">
        <h2 className="h2">Account</h2>
        <div className="row"><Icon name="user" /><span className="grow">{status.user?.email}</span>
          <Button onClick={async () => { await t.call('logout'); onSignedOut(); }}>Sign out</Button></div>
      </section>
      <section className="card">
        <h2 className="h2">This computer</h2>
        <label className="field"><span className="label">Name shown to people whose files you have</span>
          <div className="row"><input className="grow" value={deviceName} placeholder="Your computer's name" onChange={(e) => setDeviceName(e.target.value)} aria-label="Computer name" />
            <Button onClick={() => set('deviceName', deviceName, 'Name saved.')}>Save</Button></div>
          <span className="muted small">Leave empty to use your computer's name.</span></label>
        <label className="toggle"><input type="checkbox" checked={!!a?.openAtLogin} onChange={async (e) => { await t.setOpenAtLogin(e.target.checked); app.reload(); }} />
          <span><strong>Start Tether when I sign in to Windows</strong><span className="muted small">Recommended, so your files stay protected and in sync.</span></span></label>
        <label className="toggle"><input type="checkbox" checked={!!a?.explorerMenu} onChange={async (e) => { await t.setExplorerMenu(e.target.checked); app.reload(); }} />
          <span><strong>Show Tether in File Explorer's right-click menu</strong><span className="muted small">On Windows 11 it's under "Show more options".</span></span></label>
        <label className="field"><span className="label">Notifications</span>
          <select value={cfg.data?.notifications ?? 'all'} onChange={(e) => set('notifications', e.target.value)} aria-label="Notifications">
            <option value="all">Tell me about everything important</option><option value="errors">Only problems</option><option value="off">Never</option>
          </select></label>
      </section>
      <section className="card">
        <h2 className="h2">Updates</h2>
        <p>Tether {a?.appVersion ?? ''} {up.status === 'current' && '· up to date'}{up.status === 'checking' && '· checking…'}{up.status === 'downloading' && `· downloading update ${up.percent ?? 0}%`}{up.status === 'error' && `· couldn't check (${up.message})`}{up.status === 'development' && '· development copy'}</p>
        <div className="row">
          {up.status === 'ready' ? <Button kind="primary" onClick={() => t.installUpdate()}>Restart to update to {up.version}</Button>
            : <Button disabled={up.status === 'development'} onClick={() => t.checkUpdate()}>Check for updates</Button>}
        </div>
      </section>
      <details className="card">
        <summary className="h2">Advanced</summary>
        <label className="field"><span className="label">Server</span>
          <div className="row"><input className="grow" value={server} onChange={(e) => setServer(e.target.value)} aria-label="Server address" />
            <Button onClick={async () => { await set('server', server, 'Server changed. Sign in again if asked.'); reloadStatus(); }}>Save</Button></div></label>
        <label className="field"><span className="label">Check the server every (seconds)</span>
          <div className="row"><input type="number" min="10" value={tick} onChange={(e) => setTick(e.target.value)} aria-label="Check interval" />
            <Button onClick={() => set('tickSeconds', tick)}>Save</Button></div>
          <span className="muted small">Only used when instant updates are unavailable. At least 10.</span></label>
        <div className="field"><span className="label">Folders searched when a file goes missing</span>
          <ul className="kids">{(cfg.data?.scanRoots ?? []).map((r) => <li key={r}><Icon name="folder" size={16} /><span className="grow">{r}</span>
            <Button small onClick={() => set('scanRoots', cfg.data.scanRoots.filter((x) => x !== r).join(';'))}>Remove</Button></li>)}</ul>
          <Button small icon="plus" onClick={async () => { const d = await t.pick({ kind: 'folder', title: 'Add a folder to search' }); if (d) await set('scanRoots', [...(cfg.data?.scanRoots ?? []), d].join(';')); }}>Add folder</Button></div>
        <p className="muted small">Background service: version {status.version}{status.offline ? ` · offline (${status.offline})` : ' · running'}</p>
      </details>
      <section className="card row">
        <div className="grow"><strong>Quit Tether</strong><p className="muted small">Files stop syncing and are no longer protected until you open Tether again.</p></div>
        <Button onClick={() => setQuit(true)}>Quit</Button>
      </section>
      {quit && <Confirm title="Quit Tether?" text="Your files stop syncing and are not protected from accidental changes until you open Tether again." yes="Quit" onYes={() => t.quit()} onClose={() => setQuit(false)} />}
    </div>
  );
}

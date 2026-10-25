// The window: sidebar, pages, and the actions that come from buttons, File Explorer and drag & drop.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { t, useLoad, baseName, errorText } from './lib.js';
import { Toasts, useToast, Icon, Logo, Confirm } from './ui.jsx';
import { ShareFlow, GetFlow, ResolveFlow, LocateFlow } from './flows.jsx';
import { SignIn, Files, Detail, Collections, Activity, Settings } from './screens.jsx';
import './app.css';

const samePath = (a = '', b = '') => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');

function App() {
  const status = useLoad(() => t.call('status'), [], 3000);
  const app = useLoad(() => t.info(), []);
  const cfg = useLoad(() => t.call('config.get'), []);
  const [page, setPage] = useState('files');
  const [open, setOpen] = useState(null); // instanceId shown in detail
  const [tab, setTab] = useState('overview');
  const [flow, setFlow] = useState(null);
  const [dragging, setDragging] = useState(false);
  const toast = useToast();
  const s = status.data;

  /** One place for every action: buttons in the app, Explorer's menu, drag & drop. */
  async function act(verb, item, path) {
    const where = item?.path ?? path;
    try {
      if (verb === 'share') return setFlow({ kind: 'share', path: where });
      if (verb === 'get') return setFlow({ kind: 'get' });
      if (verb === 'show') {
        const hit = s?.instances.find((i) => samePath(i.path, where));
        if (!hit) return toast(`${baseName(where)} isn't shared with Tether. Use Share to share it.`, 'info');
        setPage('files');
        setOpen(hit.folderInstanceId ?? hit.instanceId);
        return setTab('overview');
      }
      if (verb === 'edit' || verb === 'live') {
        const r = await t.call('edit', { path: where, realtime: verb === 'live' });
        if (r.realtime) toast(`Live editing ${baseName(where)}: every save is shared within seconds. Press Done when you finish.`, 'good');
        else if (r.changed.length) toast(`You can change ${baseName(where)} now. Press Done to share your changes.`, 'good');
        else toast(`${baseName(where)} is already open for changes.`, 'info');
        for (const w of r.warnings ?? []) toast(`${w.email} is changing ${baseName(w.path)} live. Expect to choose between versions when you're done.`, 'info');
        return status.reload();
      }
      if (verb === 'done') return setFlow({ kind: 'resolve', path: where, from: 'editing' });
      if (verb === 'track') return setFlow({ kind: 'resolve', path: where, from: 'unmanaged' });
      if (verb === 'unmanage') return setFlow({ kind: 'confirm-unmanage', path: where });
      if (verb === 'find') return setFlow({ kind: 'locate', item });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  // Explorer's menu: actions arrive while the app runs, or wait until the window is ready
  const actRef = useRef(act);
  actRef.current = act;
  const ready = !!s?.user;
  useEffect(() => { t.onAction((a) => actRef.current(a.verb, null, a.path)); }, []);
  useEffect(() => { if (ready) t.takeAction().then((a) => a && actRef.current(a.verb, null, a.path)); }, [ready]);

  // drag a file or folder onto the window to share it
  useEffect(() => {
    const over = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); setDragging(true); } };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) act('share', null, t.pathOf(f));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [s]);

  if (status.error && !s) {
    return <div className="center"><Logo size={48} /><p>Starting Tether…</p><p className="muted small">{errorText(status.error)}</p></div>;
  }
  if (!s) return <div className="center"><Logo size={48} /><p className="muted">Starting Tether…</p></div>;
  if (!s.user) return <SignIn onSignedIn={() => { status.reload(); toast('Signed in.', 'good'); }} />;

  const item = open && s.instances.find((i) => i.instanceId === open);
  const nav = [['files', 'Your files', 'file'], ['collections', 'Collections', 'box'], ['activity', 'Activity', 'activity'], ['settings', 'Settings', 'gear']];
  const closeFlow = () => { setFlow(null); status.reload(); };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><Logo /> <span>Tether</span></div>
        <nav aria-label="Main">
          {nav.map(([k, label, icon]) => (
            <button key={k} className={page === k ? 'on' : ''} aria-current={page === k ? 'page' : undefined} onClick={() => { setPage(k); setOpen(null); }}>
              <Icon name={icon} /> {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${s.offline ? 'dot-warn' : 'dot-good'}`} />
          <span className="small">{s.offline ? 'Offline' : 'Connected'}</span>
          <span className="small muted ellipsis" title={s.user.email}>{s.user.email}</span>
        </div>
      </aside>
      <main className="content">
        {page === 'files' && (item
          ? <Detail item={item} status={s} tab={tab} setTab={setTab} onBack={() => setOpen(null)} onAction={(v, i) => act(v, i)} reloadStatus={status.reload} scanRoots={cfg.data?.scanRoots} />
          : <Files status={s} onOpen={(id) => { setOpen(id); setTab('overview'); }} onShare={() => act('share')} onGet={() => act('get')} onAction={(v, i) => act(v, i)} />)}
        {page === 'collections' && <Collections />}
        {page === 'activity' && <Activity />}
        {page === 'settings' && <Settings status={s} reloadStatus={status.reload} onSignedOut={status.reload} />}
      </main>
      {dragging && <div className="dropzone"><Icon name="share" size={40} /><p>Drop to share with Tether</p></div>}
      {flow?.kind === 'share' && <ShareFlow path={flow.path} onClose={closeFlow} onDone={status.reload} />}
      {flow?.kind === 'get' && <GetFlow documents={app.data?.documents ?? ''} onClose={closeFlow} onDone={status.reload} />}
      {flow?.kind === 'resolve' && <ResolveFlow path={flow.path} from={flow.from} onClose={closeFlow} onDone={status.reload} />}
      {flow?.kind === 'locate' && <LocateFlow item={flow.item} scanRoots={cfg.data?.scanRoots} onClose={closeFlow} onDone={status.reload} />}
      {flow?.kind === 'confirm-unmanage' && (
        <Confirm title={`Stop syncing ${baseName(flow.path)}?`} text="Your copy stays as it is on this computer. Changes others make won't arrive and yours won't be shared until you choose Sync again." yes="Stop syncing"
          onYes={async () => { await t.call('unmanage', { path: flow.path }); toast(`${baseName(flow.path)} is no longer syncing on this computer.`, 'good'); }}
          onClose={closeFlow} />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Toasts><App /></Toasts></StrictMode>);

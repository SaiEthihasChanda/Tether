// Guided flows that replace the CLI's commands and questions: share, get, done / sync again,
// the git question, and finding a lost file.
import { useEffect, useState } from 'react';
import { t, baseName, joinPath, friendlyDir, CHOICES, changeText, errorText, ROLE } from './lib.js';
import { Modal, Button, Copy, Icon, Chip, useToast } from './ui.jsx';

// ---------------------------------------------------------------- the git question
/** Asks how Tether and git share a file inside a git repository. Resolves to keep | follow | skip. */
export function GitChoice({ path, repoRoot, canFollow, onChoose, onClose }) {
  const [choice, setChoice] = useState('keep');
  const opts = [
    ['keep', "Keep Tether's version", "If git changes it (a pull, switching branch…), Tether puts the shared version back. Git won't show it as changed."],
    ['follow', "Accept git's changes", 'When git updates it, Tether shares git’s version with everyone.', !canFollow && 'Only people who can edit can choose this.'],
    ['skip', "Don't sync it with Tether", 'Leave it to git alone.'],
  ];
  return (
    <Modal title="This is inside a git repository" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" onClick={() => onChoose(choice)}>Continue</Button>
    </>}>
      <p><strong>{baseName(path)}</strong> is in the git repository <code>{repoRoot}</code>. What should happen when git changes it?</p>
      <div className="choices">
        {opts.map(([v, title, text, disabled]) => (
          <label key={v} className={`choice${choice === v ? ' on' : ''}${disabled ? ' disabled' : ''}`}>
            <input type="radio" name="git" checked={choice === v} disabled={!!disabled} onChange={() => setChoice(v)} />
            <span><strong>{title}</strong><span className="muted">{disabled || text}</span></span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/** Runs the git question when needed: resolves to { gitMode } or null when the user cancels. */
export function useGitQuestion() {
  const [ask, setAsk] = useState(null);
  const run = async (path, canFollow) => {
    const repoRoot = await t.gitRepoOf(path);
    if (!repoRoot) return { gitMode: undefined };
    return new Promise((resolve) => setAsk({ path, repoRoot, canFollow, resolve }));
  };
  const ui = ask && (
    <GitChoice {...ask}
      onChoose={(m) => { ask.resolve({ gitMode: m }); setAsk(null); }}
      onClose={() => { ask.resolve(null); setAsk(null); }} />
  );
  return [run, ui];
}

// ---------------------------------------------------------------- share
const LAST_REPO = 'tether.lastRepo';
export const DEFAULT_REPO = 'My files';

/** Share a file or folder: pick where it belongs (a collection), answer the git question, get a code. */
export function ShareFlow({ path: initial, onClose, onDone }) {
  const [path, setPath] = useState(initial ?? '');
  const [repos, setRepos] = useState(null);
  const [repo, setRepo] = useState('');
  const [newRepo, setNewRepo] = useState('');
  const [result, setResult] = useState(null);
  const [askGit, gitUi] = useGitQuestion();
  const toast = useToast();
  useEffect(() => {
    t.call('repo.list').then((list) => {
      setRepos(list);
      let last = '';
      try { last = localStorage.getItem(LAST_REPO) ?? ''; } catch { /* storage off */ }
      setRepo(list.find((r) => r.repoId === last)?.repoId ?? list[0]?.repoId ?? '__new');
      if (!list.length) setNewRepo(DEFAULT_REPO);
    }, (e) => toast(errorText(e), 'error'));
  }, []);

  async function share() {
    const git = await askGit(path, true);
    if (!git) return;
    if (git.gitMode === 'skip') return onClose();
    let repoId = repo;
    if (repo === '__new') repoId = (await t.call('repo.create', { name: newRepo.trim() || DEFAULT_REPO })).repoId;
    try { localStorage.setItem(LAST_REPO, repoId); } catch { /* storage off */ }
    const r = await t.call('manage', { path, repo: repoId, gitMode: git.gitMode });
    setResult(r);
    onDone?.();
  }

  if (result) {
    return (
      <Modal title="Shared" onClose={onClose} footer={<Button kind="primary" onClick={() => onClose(result)}>Done</Button>}>
        <p><strong>{baseName(result.path)}</strong> is now kept in sync{result.kind === 'folder' ? ` (${result.files} files)` : ''}. Send this share code to the people who should have it:</p>
        <div className="share-code"><code data-testid="share-code">{result.shareId}</code><Copy text={result.shareId} label="Copy code" /></div>
        <p className="muted">They open Tether, choose <strong>Open a share code</strong> and paste it. Anyone with the code can get a view-only copy; you can make people editors or restrict access under People.</p>
        {result.skippedSymlinks?.length > 0 && <p className="muted">Shortcuts (symlinks) inside the folder were left out: {result.skippedSymlinks.join(', ')}</p>}
      </Modal>
    );
  }
  return (
    <>
      <Modal title="Share a file or folder" onClose={onClose} footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" icon="share" disabled={!path || !repos || (repo === '__new' && !newRepo.trim())} onClick={share}>Share</Button>
      </>}>
        <div className="field">
          <span className="label">What to share</span>
          <div className="row">
            <div className="path-box grow" title={path}>{path ? <><Icon name="file" size={16} /> {baseName(path)} <span className="muted">in {friendlyDir(path)}</span></> : <span className="muted">Nothing chosen yet</span>}</div>
            <Button small onClick={async () => { const p = await t.pick({ kind: 'file', title: 'Choose a file to share' }); if (p) setPath(p); }}>Choose file…</Button>
            <Button small onClick={async () => { const p = await t.pick({ kind: 'folder', title: 'Choose a folder to share' }); if (p) setPath(p); }}>Choose folder…</Button>
          </div>
        </div>
        <label className="field">
          <span className="label">Keep it in</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Collection">
            {repos?.map((r) => <option key={r.repoId} value={r.repoId}>{r.name}</option>)}
            <option value="__new">New collection…</option>
          </select>
          <span className="muted small">Collections group the things you share. Most people need only one.</span>
        </label>
        {repo === '__new' && (
          <label className="field">
            <span className="label">Name of the new collection</span>
            <input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder={DEFAULT_REPO} />
          </label>
        )}
      </Modal>
      {gitUi}
    </>
  );
}

// ---------------------------------------------------------------- get
/** Open a share code: check it, choose where to put it, answer the git question, download. */
export function GetFlow({ documents, onClose, onDone }) {
  const [code, setCode] = useState('');
  const [peek, setPeek] = useState(null);
  const [folder, setFolder] = useState(documents);
  const [result, setResult] = useState(null);
  const [askGit, gitUi] = useGitQuestion();
  const clean = code.trim().toLowerCase();

  async function check() {
    const p = await t.call('pull', { shareId: clean, cwd: folder, peek: true });
    setPeek({ ...p, name: baseName(p.path) });
  }
  // a folder is created inside the chosen place; a file is put into it
  const dest = peek ? joinPath(folder, peek.name) : null;
  async function get() {
    const git = await askGit(dest, peek.role !== 'viewer');
    if (!git) return;
    if (git.gitMode === 'skip') return onClose();
    const r = await t.call('pull', { shareId: clean, dest, cwd: folder, gitMode: git.gitMode });
    setResult(r);
    onDone?.();
  }

  if (result) {
    return (
      <Modal title="It's on your computer" onClose={onClose} footer={<>
        <Button icon="open" onClick={() => t.reveal(result.path)}>Show in folder</Button>
        <Button kind="primary" onClick={() => onClose(result)}>Done</Button>
      </>}>
        <p><strong>{baseName(result.path)}</strong> is saved in {friendlyDir(result.path)} and will stay in sync. {result.role === 'viewer' ? 'You can view it; only editors can change it for everyone.' : 'You can change it with Make changes.'}</p>
        {result.note && <p className="muted">{result.note}</p>}
      </Modal>
    );
  }
  return (
    <>
      <Modal title="Open a share code" onClose={onClose} footer={<>
        <Button onClick={onClose}>Cancel</Button>
        {peek ? <Button kind="primary" icon="download" onClick={get}>Get it</Button> : <Button kind="primary" disabled={clean.length < 6} onClick={check}>Next</Button>}
      </>}>
        <label className="field">
          <span className="label">Share code</span>
          <input value={code} onChange={(e) => { setCode(e.target.value); setPeek(null); }} placeholder="abcd-efgh-jkmn" aria-label="Share code" spellCheck="false" autoComplete="off" />
          <span className="muted small">The person who shared it can find the code in their Tether app.</span>
        </label>
        {peek && (
          <>
            <div className="found">
              <Icon name={peek.kind === 'folder' ? 'folder' : 'file'} size={22} />
              <div><strong>{peek.name}</strong><div className="muted small">A {peek.kind} · you {peek.role === 'viewer' ? 'can view it' : 'can edit it'}</div></div>
              <Chip tone={peek.role === 'viewer' ? 'muted' : 'accent'}>{ROLE[peek.role]}</Chip>
            </div>
            <div className="field">
              <span className="label">Save it in</span>
              <div className="row">
                <div className="path-box grow" title={folder}><Icon name="folder" size={16} /> {folder}</div>
                <Button small onClick={async () => { const p = await t.pick({ kind: 'folder', title: 'Where should it go?', defaultPath: folder }); if (p) setFolder(p); }}>Change…</Button>
              </div>
            </div>
          </>
        )}
      </Modal>
      {gitUi}
    </>
  );
}

// ---------------------------------------------------------------- done / sync again
/**
 * Finishing changes (`from: 'editing'`) or syncing again (`from: 'unmanaged'`): Tether works out
 * what changed; anything that needs a decision is asked in plain words.
 */
export function ResolveFlow({ path, from, onClose, onDone }) {
  const [plan, setPlan] = useState(null);
  const [choices, setChoices] = useState({});
  const [diff, setDiff] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  async function apply(p, ch) {
    const r = await t.call('resolve', { path, from, items: p.items, choices: ch });
    setResults(r.results);
    onDone?.();
  }
  useEffect(() => {
    t.call('plan', { path, from }).then(async (p) => {
      if (!p.items.some((i) => i.options)) await apply(p, {});
      else {
        setPlan(p);
        setChoices(Object.fromEntries(p.items.filter((i) => i.options).map((i) => [i.instanceId, i.options.includes('push') && !i.conflict ? 'push' : 'cancel'])));
      }
    }).catch(setError);
  }, []);

  if (error) {
    return <Modal title="Something went wrong" onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Close</Button>}><p>{errorText(error)}</p></Modal>;
  }
  if (results) {
    const word = { push: 'Shared', accept: 'Updated to the shared version', 'keep-both': 'Kept both', cancel: 'Left for later', delete: 'Deleted for everyone', stop: 'Stopped syncing', clean: 'No changes', adopt: 'Already the same', restore: 'Brought back', orphan: 'No longer shared' };
    return (
      <Modal title={from === 'editing' ? 'Done' : 'Syncing again'} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Close</Button>}>
        <ul className="results">
          {results.map((r) => (
            <li key={r.path}>
              <Icon name={r.error ? 'alert' : 'check'} size={16} className={r.error ? 'tone-warn' : 'tone-good'} />
              <span><strong>{baseName(r.path)}</strong>: {r.error ? errorText({ message: r.error }) : word[r.action] ?? r.action}
                {r.version ? ` (version ${r.version})` : ''}{r.keptAs ? `; your copy is ${baseName(r.keptAs)}` : ''}</span>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }
  if (!plan) return <Modal title={from === 'editing' ? 'Finishing your changes…' : 'Checking…'}><p className="muted">One moment.</p></Modal>;
  const ask = plan.items.filter((i) => i.options);
  return (
    <>
      <Modal wide title={ask.length === 1 ? 'One decision needed' : `${ask.length} decisions needed`} onClose={onClose} footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" onClick={() => apply(plan, choices)}>Apply</Button>
      </>}>
        {ask.map((item) => (
          <section key={item.instanceId} className="decision">
            <h3><Icon name="file" size={16} /> {item.relPath ?? baseName(item.path)}</h3>
            <p className="muted">
              {item.change ? `${changeText(item.change)[0].toUpperCase()}${changeText(item.change).slice(1)}` : 'It changed'}
              {item.incoming ? `, and someone else shared a newer version (version ${item.serverVersion}).` : '.'}
              {item.role === 'viewer' ? ' You can view this file but not change it for everyone.' : ''}
            </p>
            <div className="choices">
              {item.options.filter((o) => o !== 'diff').map((o) => (
                <label key={o} className={`choice${choices[item.instanceId] === o ? ' on' : ''}`}>
                  <input type="radio" name={item.instanceId} checked={choices[item.instanceId] === o} onChange={() => setChoices({ ...choices, [item.instanceId]: o })} />
                  <span><strong>{CHOICES[o]?.[0] ?? o}</strong><span className="muted">{CHOICES[o]?.[1]}</span></span>
                </label>
              ))}
            </div>
            {item.options.includes('diff') && (
              <Button small icon="list" onClick={async () => setDiff({ name: baseName(item.path), text: (await t.call('diff', { instanceId: item.instanceId })).text })}>Show the differences</Button>
            )}
          </section>
        ))}
      </Modal>
      {diff && <DiffView {...diff} onClose={() => setDiff(null)} />}
    </>
  );
}

export function DiffView({ name, text, onClose }) {
  const lines = (text || '').split('\n').filter((l) => !/^(Index:|={5,}|---|\+\+\+)/.test(l));
  return (
    <Modal wide title={`What changed in ${name}`} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Close</Button>}>
      <p className="muted small">Lines in green are in your copy only; lines in red are in the shared version only.</p>
      {lines.length ? (
        <pre className="diff">{lines.map((l, n) => <span key={n} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l + '\n'}</span>)}</pre>
      ) : <p>No differences in the content.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- find a lost file
export function LocateFlow({ item, scanRoots = [], onClose, onDone }) {
  const [found, setFound] = useState(null);
  const toast = useToast();
  async function search(dirs) {
    const r = await t.call('locate', { instanceId: item.instanceId, dirs });
    setFound(r.candidates);
  }
  async function link(file) {
    await t.call('locate', { instanceId: item.instanceId, file });
    toast(`Found it: ${baseName(file)} is synced again.`, 'good');
    onDone?.();
    onClose();
  }
  return (
    <Modal title={`Find ${baseName(item.path)}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p>Tether looks for a file with the same content. Search your folders, or show Tether exactly where it is.</p>
      <div className="row wrap">
        <Button kind="primary" icon="search" onClick={() => search(scanRoots)}>Search my folders</Button>
        <Button icon="folder" onClick={async () => { const d = await t.pick({ kind: 'folder', title: 'Search in…' }); if (d) await search([d]); }}>Search in a folder…</Button>
        <Button icon={item.kind === 'folder' ? 'folder' : 'file'} onClick={async () => { const f = await t.pick({ kind: item.kind === 'folder' ? 'folder' : 'file', title: `Where is ${baseName(item.path)}?` }); if (f) await link(f); }}>It's here…</Button>
      </div>
      {found && (found.length ? (
        <ul className="candidates">
          {found.map((c) => <li key={c}><span title={c}>{baseName(c)} <span className="muted">in {friendlyDir(c)}</span></span><Button small kind="primary" onClick={() => link(c)}>This one</Button></li>)}
        </ul>
      ) : <p className="muted">Nothing with the same content was found there.</p>)}
    </Modal>
  );
}

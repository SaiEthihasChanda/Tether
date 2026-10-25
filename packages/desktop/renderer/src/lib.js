// Talking to the app, and turning Tether's internal states into plain language.
import { useCallback, useEffect, useRef, useState } from 'react';

export const t = window.tether;

/** Loads data, reloads on demand, and optionally every `every` ms while the window is visible. */
export function useLoad(fn, deps = [], every = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const data = await fn();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (alive.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    alive.current = true;
    load();
    if (!every) return () => (alive.current = false);
    const id = setInterval(() => document.visibilityState === 'visible' && load(), every);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load, every]);
  return { ...state, reload: load };
}

export function timeAgo(d) {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(d).toLocaleDateString();
}

export const baseName = (p = '') => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const dirName = (p = '') => p.replace(/[\\/][^\\/]*$/, '');
export const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}\\${name}`;
/** "C:\Users\sam\Documents\work" -> "Documents › work" when it is under the user's folder. */
export function friendlyDir(p = '') {
  const d = dirName(p);
  const m = d.match(/^[A-Za-z]:\\Users\\[^\\]+\\?(.*)$/);
  if (m) return m[1] ? m[1].split('\\').join(' › ') : 'Your user folder';
  return d;
}

export const ROLE = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };

/**
 * What a shared item looks like right now, in words: label + tone for the chip, a sentence for
 * the details, and the main thing to do next.
 */
export function describe(i) {
  if (i.mode === 'orphaned') {
    const why = { deleted: 'It was deleted for everyone.', revoked: 'Your access was removed.', purged: 'It was removed from the server.' }[i.orphanReason] ?? 'It is no longer shared.';
    return { label: 'No longer synced', tone: 'muted', text: `${why} Your copy stays on this computer as an ordinary file.`, action: null };
  }
  if (i.detached) return { label: 'Deleted here', tone: 'warn', text: 'The file was deleted on this computer. You can bring it back or find it if you moved it.', action: 'find' };
  if (i.missing) return { label: "Can't find it", tone: 'warn', text: 'Tether is looking for it. If you moved it somewhere unusual, show Tether where it is.', action: 'find' };
  if (i.mode === 'unmanaged') {
    return { label: 'Not syncing', tone: 'muted', text: 'This copy is not kept in sync. Changes others make do not arrive, and yours are not shared.', action: 'track' };
  }
  if (i.mode === 'editing') {
    if (i.realtime) return { label: 'Live editing', tone: 'accent', text: 'Every time you save, your changes are shared with everyone within seconds.', action: 'done' };
    const more = i.remoteVersion > i.version ? ' Someone else has also shared a newer version; you will choose what to keep when you are done.' : '';
    return {
      label: i.modified ? 'Changes not shared yet' : 'Making changes', tone: 'accent',
      text: `You can change this ${i.kind}. Nothing is shared until you press Done.${more}`, action: 'done',
    };
  }
  if (i.gitWaiting) return { label: 'Waiting for git', tone: 'info', text: 'A newer version came from git. It arrives on this computer with your next git pull.', action: canEdit(i) ? 'edit' : null };
  if (i.remoteVersion > i.version || i.restoring) return { label: 'Updating…', tone: 'info', text: 'A newer version is being downloaded.', action: null };
  if (i.lastError) return { label: 'Needs attention', tone: 'warn', text: i.lastError, action: canEdit(i) ? 'edit' : null };
  return {
    label: 'In sync', tone: 'good',
    text: canEdit(i)
      ? `This ${i.kind} matches the shared version. If it is changed by accident, Tether puts it back. To change it on purpose, press Make changes.`
      : `This ${i.kind} matches the shared version. You can view it; only editors can change it for everyone.`,
    action: canEdit(i) ? 'edit' : null,
  };
}
export const canEdit = (i) => i.role === 'owner' || i.role === 'editor';

/** Plain words for the choices `done` / `track` can offer. */
export const CHOICES = {
  push: ['Share my version', 'Everyone gets your version. The other version stays in the history, so nothing is lost.'],
  accept: ['Use the shared version', 'Your changes on this computer are thrown away and replaced with the shared version.'],
  'keep-both': ['Keep both', 'Your version is saved as a separate copy next to it, and this one gets the shared version.'],
  cancel: ['Decide later', 'Nothing changes for now. You can come back to it.'],
  delete: ['Delete it for everyone', 'It disappears for everyone who has it. The owner can bring it back from the history.'],
  stop: ['Only stop syncing it here', 'Nothing changes for anyone else.'],
};

export const CHANGE = {
  content: 'you changed it',
  deleted: 'you deleted it on this computer',
  'moved-out': 'you moved it out of its shared folder',
  missing: 'it is missing on this computer',
};
export const changeText = (c = '') => c.split(', ').map((x) => CHANGE[x] ?? (x.startsWith('moved to ') ? `you moved it to ${x.slice(9)}` : x)).join(' and ');

export const HISTORY_TYPE = {
  create: 'Shared for the first time', content: 'Changed', move: 'Moved', delete: 'Deleted', restore: 'Restored', rollback: 'Went back to an earlier version',
  add: 'File added', 'content+move': 'Changed and moved',
};
export const historyText = (v) => (v.type === 'rollback' && v.rolledBackTo ? `Went back to version ${v.rolledBackTo}` : HISTORY_TYPE[v.type] ?? v.type) + (v.relPath && ['add', 'move', 'delete', 'restore'].includes(v.type) ? `: ${v.relPath}` : '');

/** Daemon errors in plain words. */
export function errorText(e) {
  const m = e?.message ?? String(e);
  if (/not signed in/i.test(m)) return 'You are signed out. Sign in again to keep syncing.';
  if (/no artifact with that share ID/i.test(m)) return "That share code doesn't work. Check it, or ask the owner for a new one.";
  if (/already a managed copy/i.test(m)) return 'There is already a synced copy at that place.';
  if (/already exists with different content/i.test(m)) return 'A different file with that name is already there. Choose another place.';
  if (/offline|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(m)) return 'Tether cannot reach the internet right now. Try again when you are back online.';
  return m.replace(/`tether ([a-z]+)[^`]*`/g, (_, c) => `"${{ edit: 'Make changes', done: 'Done', track: 'Sync again', unmanage: 'Stop syncing' }[c] ?? c}"`);
}

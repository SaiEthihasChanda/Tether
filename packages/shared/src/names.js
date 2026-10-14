// Name validation (DESIGN §8.2): reject anything that can't exist on both Windows and Linux.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;
export const MAX_REL_PATH = 200;

/** Returns an error message for an invalid single path segment, or null. */
export function nameError(name) {
  if (!name || name === '.' || name === '..') return `invalid name "${name}"`;
  if (ILLEGAL.test(name)) return `"${name}" contains a character not allowed on Windows`;
  if (/[. ]$/.test(name)) return `"${name}" ends with a dot or space`;
  if (RESERVED.test(name)) return `"${name}" is a reserved name on Windows`;
  if (Buffer.byteLength(name) > 255) return `"${name}" is too long`;
  return null;
}

/** Returns an error message for an invalid relative path ("a/b/c.txt"), or null. */
export function relPathError(relPath) {
  if (typeof relPath !== 'string' || !relPath) return 'empty path';
  if (relPath.length > MAX_REL_PATH) return `path "${relPath}" is longer than ${MAX_REL_PATH} characters`;
  if (relPath.startsWith('/')) return `path "${relPath}" must be relative`;
  for (const seg of relPath.split('/')) {
    const e = nameError(seg);
    if (e) return e;
  }
  return null;
}

/**
 * Checks a set of relative paths for case-only collisions, including a file whose
 * name is also used as a folder on the way to another file. Returns an error or null.
 */
export function caseCollisionError(relPaths) {
  const seen = new Map();
  for (const p of relPaths) {
    const segs = p.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      const key = prefix.toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined && prev !== prefix) return `"${prev}" and "${prefix}" differ only by case`;
      seen.set(key, prefix);
    }
  }
  const files = new Set(relPaths.map((p) => p.toLowerCase()));
  for (const p of relPaths) {
    const segs = p.toLowerCase().split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (files.has(prefix)) return `"${prefix}" is both a file and a folder`;
    }
  }
  return null;
}

/** Normalize an OS relative path to forward slashes. */
export const toPosix = (p) => p.split('\\').join('/');

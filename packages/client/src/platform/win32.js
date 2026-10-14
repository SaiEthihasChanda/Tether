// Win32 bindings used by the Windows tracker and credential store.
// File identity uses FILE_ID_INFO (volume serial + 128-bit file ID), which works on
// NTFS and ReFS. Lookups use OpenFileById(ExtendedFileIdType) + GetFinalPathNameByHandleW.
import koffi from 'koffi';
import path from 'node:path';

const kernel32 = koffi.load('kernel32.dll');
const crypt32 = koffi.load('crypt32.dll');

const HANDLE = 'intptr';
const INVALID_HANDLE = -1;

const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4; // READ | WRITE | DELETE
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000; // required to open directories
const FILE_ID_INFO_CLASS = 18;
const EXTENDED_FILE_ID_TYPE = 2;

const CreateFileW = kernel32.func('CreateFileW', HANDLE, ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', HANDLE]);
const CloseHandle = kernel32.func('CloseHandle', 'bool', [HANDLE]);
const GetLastError = kernel32.func('GetLastError', 'uint32', []);
const GetFileInformationByHandleEx = kernel32.func('GetFileInformationByHandleEx', 'bool', [HANDLE, 'int', 'void *', 'uint32']);
const OpenFileById = kernel32.func('OpenFileById', HANDLE, [HANDLE, 'void *', 'uint32', 'uint32', 'void *', 'uint32']);
const GetFinalPathNameByHandleW = kernel32.func('GetFinalPathNameByHandleW', 'uint32', [HANDLE, 'void *', 'uint32', 'uint32']);
const LocalFree = kernel32.func('LocalFree', 'void *', ['void *']);

const DATA_BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
const CryptProtectData = crypt32.func('CryptProtectData', 'bool', [koffi.pointer(DATA_BLOB), 'str16', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(DATA_BLOB))]);
const CryptUnprotectData = crypt32.func('CryptUnprotectData', 'bool', [koffi.pointer(DATA_BLOB), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(DATA_BLOB))]);

function openPath(p) {
  const h = CreateFileW(toLong(p), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, 0);
  if (Number(h) === INVALID_HANDLE) return null;
  return h;
}

function toLong(p) {
  const abs = path.resolve(p);
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs;
}

function stripLong(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function idOfHandle(h) {
  const buf = Buffer.alloc(24);
  if (!GetFileInformationByHandleEx(h, FILE_ID_INFO_CLASS, buf, buf.length)) return null;
  return {
    volumeId: buf.readBigUInt64LE(0).toString(16).padStart(16, '0'),
    fileId: buf.subarray(8, 24).toString('hex'),
  };
}

function finalPath(h) {
  let cap = 512;
  for (;;) {
    const buf = Buffer.alloc(cap * 2);
    const n = GetFinalPathNameByHandleW(h, buf, cap, 0);
    if (n === 0) return null;
    if (n < cap) return stripLong(buf.toString('utf16le', 0, n * 2));
    cap = n + 1;
  }
}

/** Identity of the file or directory at `p`, or null if it can't be opened. */
export function fileIdentity(p) {
  const h = openPath(p);
  if (h === null) return null;
  try {
    return idOfHandle(h);
  } finally {
    CloseHandle(h);
  }
}

// One open handle per volume root, used as the OpenFileById volume hint.
const volumeHints = new Map(); // volumeId -> handle

function volumeHint(volumeId, nearPath) {
  let h = volumeHints.get(volumeId);
  if (h !== undefined) return h;
  const root = path.parse(path.resolve(nearPath)).root;
  h = openPath(root);
  if (h === null) return null;
  const id = idOfHandle(h);
  if (!id || id.volumeId !== volumeId) {
    CloseHandle(h);
    return null;
  }
  volumeHints.set(volumeId, h);
  return h;
}

/**
 * Current path of a file by its identity, or null if no file with that ID exists
 * on the volume (deleted, or moved to another volume). `nearPath` is any path on
 * the same volume (normally the last known path) used to find the volume root.
 */
export function pathById(volumeId, fileId, nearPath) {
  const hint = volumeHint(volumeId, nearPath);
  if (hint === null) return null;
  const desc = Buffer.alloc(24);
  desc.writeUInt32LE(24, 0);
  desc.writeInt32LE(EXTENDED_FILE_ID_TYPE, 4);
  Buffer.from(fileId, 'hex').copy(desc, 8);
  const h = OpenFileById(hint, desc, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, FILE_FLAG_BACKUP_SEMANTICS);
  if (Number(h) === INVALID_HANDLE) {
    GetLastError();
    return null;
  }
  try {
    return finalPath(h);
  } finally {
    CloseHandle(h);
  }
}

/** True if the path is inside a Recycle Bin folder (a delete keeps the file ID). */
export function isTrashPath(p) {
  return /[\\/]\$Recycle\.Bin[\\/]/i.test(p);
}

/** Encrypt bytes for the current Windows user (DPAPI). */
export function protect(data) {
  const input = { cbData: data.length, pbData: data };
  const output = {};
  if (!CryptProtectData(input, 'tether', null, null, null, 0, output)) throw new Error('CryptProtectData failed');
  return copyBlob(output);
}

/** Decrypt bytes produced by protect(). */
export function unprotect(data) {
  const input = { cbData: data.length, pbData: data };
  const output = {};
  if (!CryptUnprotectData(input, null, null, null, null, 0, output)) throw new Error('CryptUnprotectData failed');
  return copyBlob(output);
}

function copyBlob(blob) {
  const bytes = Buffer.from(koffi.decode(blob.pbData, 'uint8', blob.cbData));
  LocalFree(blob.pbData);
  return bytes;
}

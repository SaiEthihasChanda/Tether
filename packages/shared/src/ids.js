import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l, o, 0, 1

function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Permanent artifact ID. */
export const newArtifactId = () => 'a_' + randomString(16);
/** Repository ID. */
export const newRepoId = () => 'r_' + randomString(12);
/** Public, rotatable share ID, short enough to read out loud. */
export const newShareId = () => randomString(4) + '-' + randomString(4) + '-' + randomString(4);
/** Local instance ID. */
export const newInstanceId = () => 'i_' + randomString(10);
/** Opaque random token. */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

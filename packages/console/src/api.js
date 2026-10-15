// Console API client. The server's /v1/config says which auth system to use:
//   firebase: Firebase Auth (JS SDK) - production on Firebase Hosting
//   local:    the dev server's email/password auth (refresh token in localStorage)
const KEY = 'tether.refreshToken';
let mode = null; // { auth: 'local' } | { auth: 'firebase', ... }
let fb = null; // { auth, sdk } when using Firebase
let accessToken = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
  }
}

async function request(method, path, body, token, raw = false) {
  const res = await fetch('/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(res.status, json.error);
  }
  return raw ? res.arrayBuffer() : res.json().catch(() => ({}));
}

const store = {
  get: () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch {
      // private mode: the session lasts until reload
    }
  },
};

const FIREBASE_MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/email-already-in-use': 'An account with that email already exists.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
  'auth/network-request-failed': 'Network error. Check your connection.',
};
const friendly = (e) => new ApiError(400, { message: FIREBASE_MESSAGES[e.code] ?? e.message });

async function init() {
  if (mode) return mode;
  mode = await request('GET', '/config');
  if (mode.auth === 'firebase') {
    const [{ initializeApp }, sdk] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const app = initializeApp({ apiKey: mode.apiKey, authDomain: mode.authDomain, projectId: mode.projectId });
    const auth = sdk.getAuth(app);
    if (mode.emulatorHost) sdk.connectAuthEmulator(auth, `http://${mode.emulatorHost}`, { disableWarnings: true });
    fb = { auth, sdk };
  }
  return mode;
}

export const isFirebase = () => mode?.auth === 'firebase';

/** The signed-in user ({ uid, email, displayName }) or null. */
export async function restore() {
  await init();
  if (fb) {
    const user = await new Promise((resolve) => {
      const off = fb.sdk.onAuthStateChanged(fb.auth, (u) => {
        off();
        resolve(u);
      });
    });
    return user ? api('GET', '/me').catch(() => null) : null;
  }
  const rt = store.get();
  if (!rt) return null;
  try {
    const r = await request('POST', '/auth/refresh', { refreshToken: rt });
    accessToken = r.accessToken;
    return r.user;
  } catch {
    return null;
  }
}

export async function login(email, password) {
  await init();
  if (fb) {
    try {
      await fb.sdk.signInWithEmailAndPassword(fb.auth, email, password);
    } catch (e) {
      throw friendly(e);
    }
    return api('GET', '/me');
  }
  const t = await request('POST', '/auth/login', { email, password });
  accessToken = t.accessToken;
  store.set(t.refreshToken);
  return t.user;
}

export async function signup(email, password) {
  await init();
  if (fb) {
    try {
      await fb.sdk.createUserWithEmailAndPassword(fb.auth, email, password);
    } catch (e) {
      throw friendly(e);
    }
    return api('GET', '/me');
  }
  const t = await request('POST', '/auth/signup', { email, password });
  accessToken = t.accessToken;
  store.set(t.refreshToken);
  return t.user;
}

/** Firebase only: email a password-reset link. */
export async function resetPassword(email) {
  await init();
  try {
    await fb.sdk.sendPasswordResetEmail(fb.auth, email);
  } catch (e) {
    throw friendly(e);
  }
}

export async function logout() {
  if (fb) return fb.sdk.signOut(fb.auth);
  const rt = store.get();
  if (rt) await request('POST', '/auth/logout', { refreshToken: rt }).catch(() => {});
  store.set(null);
  accessToken = null;
}

async function authed(method, path, body, raw) {
  if (fb) {
    const u = fb.auth.currentUser;
    if (!u) throw new ApiError(401, { message: 'not signed in' });
    return request(method, path, body, await u.getIdToken(), raw);
  }
  try {
    return await request(method, path, body, accessToken, raw);
  } catch (e) {
    const rt = store.get();
    if (e.status !== 401 || !rt) throw e;
    accessToken = (await request('POST', '/auth/refresh', { refreshToken: rt })).accessToken;
    return request(method, path, body, accessToken, raw);
  }
}

export const api = (method, path, body) => authed(method, path, body, false);

/** Raw bytes of a file version (for previews and downloads). */
export const content = (artifactId, version) => authed('GET', `/artifacts/${artifactId}/content${version ? `?version=${version}` : ''}`, undefined, true);

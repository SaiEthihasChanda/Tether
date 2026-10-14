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

async function raw(method, path, body, token) {
  const res = await fetch('/v1' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error);
  return json;
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
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/email-already-in-use': 'An account with that email already exists.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
  'auth/network-request-failed': 'Network error. Check your connection.',
};
const friendly = (e) => new ApiError(400, { message: FIREBASE_MESSAGES[e.code] ?? e.message });

async function init() {
  if (mode) return mode;
  mode = await raw('GET', '/config');
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
    const r = await raw('POST', '/auth/refresh', { refreshToken: rt });
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
  const t = await raw('POST', '/auth/login', { email, password });
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
  const t = await raw('POST', '/auth/signup', { email, password });
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
  if (rt) await raw('POST', '/auth/logout', { refreshToken: rt }).catch(() => {});
  store.set(null);
  accessToken = null;
}

export async function api(method, path, body) {
  if (fb) {
    const u = fb.auth.currentUser;
    if (!u) throw new ApiError(401, { message: 'not signed in' });
    return raw(method, path, body, await u.getIdToken());
  }
  try {
    return await raw(method, path, body, accessToken);
  } catch (e) {
    const rt = store.get();
    if (e.status !== 401 || !rt) throw e;
    accessToken = (await raw('POST', '/auth/refresh', { refreshToken: rt })).accessToken;
    return raw(method, path, body, accessToken);
  }
}

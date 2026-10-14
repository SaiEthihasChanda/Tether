// Console API client. The refresh token lives in localStorage; access tokens in memory.
const KEY = 'tether.refreshToken';
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

const getRefresh = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

function setSession(tokens) {
  accessToken = tokens.accessToken;
  try {
    localStorage.setItem(KEY, tokens.refreshToken);
  } catch {
    // private mode: session lasts until reload
  }
  return tokens.user;
}

export async function restore() {
  const rt = getRefresh();
  if (!rt) return null;
  try {
    const r = await raw('POST', '/auth/refresh', { refreshToken: rt });
    accessToken = r.accessToken;
    return r.user;
  } catch {
    return null;
  }
}

export const login = async (email, password) => setSession(await raw('POST', '/auth/login', { email, password }));
export const signup = async (email, password, displayName) => setSession(await raw('POST', '/auth/signup', { email, password, displayName }));

export async function logout() {
  const rt = getRefresh();
  if (rt) await raw('POST', '/auth/logout', { refreshToken: rt }).catch(() => {});
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  accessToken = null;
}

export async function api(method, path, body) {
  try {
    return await raw(method, path, body, accessToken);
  } catch (e) {
    if (e.status !== 401) throw e;
    const rt = getRefresh();
    if (!rt) throw e;
    accessToken = (await raw('POST', '/auth/refresh', { refreshToken: rt })).accessToken;
    return raw(method, path, body, accessToken);
  }
}

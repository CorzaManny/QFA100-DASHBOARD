// Talks to the team's Supabase project: sign-in, and the shared schedule,
// roster and account list. Plain fetch calls, so there is nothing to install.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const BASE = SUPABASE_URL.trim().replace(/\/+$/, '');
const SESSION_KEY = 'qfa100-ops.session';

// False until config.js has been filled in; the app then runs in preview mode.
export const configured = !!(BASE && SUPABASE_ANON_KEY.trim());

let session = null;
try {
  session = JSON.parse(localStorage.getItem(SESSION_KEY));
} catch {
  // no usable saved session
}

export const getSession = () => session;

function setSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable; stay signed in for this visit only
  }
}

function keep(data) {
  setSession({
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    userId: data.user.id,
    email: data.user.email,
  });
}

const message = (data, status) =>
  data?.msg || data?.error_description || data?.message || data?.error || `Request failed (HTTP ${status})`;

async function auth(path, body, token) {
  const res = await fetch(`${BASE}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(message(data, res.status)), { status: res.status });
  return data;
}

export async function signIn(email, password) {
  keep(await auth('token?grant_type=password', { email, password }));
}

// Returns false when the account was created but the email still has to be
// confirmed before signing in (Supabase's default).
export async function signUp(email, password, displayName) {
  const data = await auth('signup', { email, password, data: { display_name: displayName } });
  if (!data.access_token) return false;
  keep(data);
  return true;
}

export async function signOut() {
  const token = session?.access;
  setSession(null);
  if (token) await auth('logout', {}, token).catch(() => {});
}

let refreshing = null;
function refresh() {
  refreshing ??= auth('token?grant_type=refresh_token', { refresh_token: session.refresh })
    .then(keep)
    .catch((err) => {
      // A rejected refresh token means the sign-in has ended; a network
      // failure does not, so keep the session and try again later.
      if (err.status) setSession(null);
      throw err;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

async function rest(method, path, body, prefer) {
  if (!session) throw new Error('Not signed in');
  if (session.expiresAt - Date.now() < 60000) await refresh();
  const send = () =>
    fetch(`${BASE}/rest/v1/${path}`, {
      method,
      cache: 'no-store',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await send();
  if (res.status === 401) {
    await refresh();
    res = await send();
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(message(data, res.status));
  return data;
}

const id = (v) => encodeURIComponent(v);

const toSector = (r) => ({
  id: r.id,
  flight: r.flight,
  dep: r.dep,
  arr: r.arr,
  std: r.std,
  sta: r.sta,
  window: r.dep_window_min || 0,
  route: r.route || '',
  notes: r.notes || '',
});

export async function loadAll() {
  const [sectors, roster, people] = await Promise.all([
    rest('GET', 'sectors?select=*&order=std.asc'),
    rest('GET', 'roster?select=id,sector_id,user_id,duty,report_at,notes'),
    rest('GET', 'profiles?select=id,display_name,vatsim_cid,role&order=display_name.asc'),
  ]);
  return { sectors: sectors.map(toSector), roster, people };
}

// fields: { flight, dep, arr, std, sta, route, notes }
export function saveSector(fields, sectorId) {
  return sectorId
    ? rest('PATCH', `sectors?id=eq.${id(sectorId)}`, fields)
    : rest('POST', 'sectors', fields);
}

export const deleteSector = (sectorId) => rest('DELETE', `sectors?id=eq.${id(sectorId)}`);

// Rostering someone twice on a sector updates their existing entry.
export const saveRoster = (entry) =>
  rest('POST', 'roster?on_conflict=sector_id,user_id', entry, 'resolution=merge-duplicates');

export const deleteRoster = (rosterId) => rest('DELETE', `roster?id=eq.${id(rosterId)}`);

export const updateProfile = (userId, fields) => rest('PATCH', `profiles?id=eq.${id(userId)}`, fields);

export const setRole = (userId, role) => rest('POST', 'rpc/set_role', { target: userId, new_role: role });

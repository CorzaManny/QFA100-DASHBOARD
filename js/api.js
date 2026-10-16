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

// Emails a link that comes back to this app and lets the person choose a new password.
export const requestReset = (email) =>
  auth(`recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { email });

async function account(method, token, body) {
  const res = await fetch(`${BASE}/auth/v1/user`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(message(data, res.status));
  return data;
}

// A link from an email (password reset, or confirming a new account) arrives
// with a sign-in in the page address. params: URLSearchParams of that address.
export async function useEmailLink(params) {
  const access = params.get('access_token');
  const user = await account('GET', access);
  keep({
    access_token: access,
    refresh_token: params.get('refresh_token'),
    expires_in: Number(params.get('expires_in')) || 3600,
    user,
  });
}

export async function setPassword(password) {
  if (!session) throw new Error('The reset link has expired. Ask for a new one.');
  if (session.expiresAt - Date.now() < 60000) await refresh();
  await account('PUT', session.access, { password });
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

// A tech log entry as the app uses it, and as the database stores it.
const toDefect = (r) => ({
  id: r.id,
  ref: r.ref,
  at: new Date(r.reported_at).getTime(),
  system: r.system,
  desc: r.description,
  by: r.reporter,
  sector: r.sector,
  status: r.status,
  melItem: r.mel_item,
  mel: r.mel_cat,
  due: r.due_at ? new Date(r.due_at).getTime() : null,
  restriction: r.restriction,
  action: r.action,
  aog: r.aog,
  shared: true,
});

const fromDefect = (d) => ({
  reported_at: new Date(d.at).toISOString(),
  system: d.system,
  description: d.desc,
  reporter: d.by,
  sector: d.sector,
  status: d.status,
  mel_item: d.melItem || '',
  mel_cat: d.mel || '',
  due_at: d.due ? new Date(d.due).toISOString() : null,
  restriction: d.restriction,
  action: d.action,
  aog: !!d.aog,
  updated_at: new Date().toISOString(),
});

export async function loadAll() {
  // Settings and availability arrived in a later database version; if the
  // database has not been updated yet, carry on without them.
  const [sectors, roster, people, settings, prefs, techlog, history, briefings, official, officialCheck, actuals, swaps, pickups, checklistStatus, fuelRequests] =
    await Promise.all([
    rest('GET', 'sectors?select=*&order=std.asc'),
    rest('GET', 'roster?select=*'),
    rest('GET', 'profiles?select=*&order=display_name.asc'),
    rest('GET', 'settings?select=*&id=eq.1').catch(() => null),
    rest('GET', 'preferences?select=user_id,sector_id,choice').catch(() => null),
    rest('GET', 'techlog?select=*&order=reported_at.desc').catch(() => null),
    rest('GET', 'techlog_history?select=defect_id,at,by_name,event,detail&order=at.asc').catch(() => null),
    rest('GET', 'briefings?select=*').catch(() => null),
    rest('GET', 'official_schedule?select=*&order=std.asc').catch(() => null),
    rest('GET', 'official_schedule_check?select=*').catch(() => null),
    rest('GET', 'sector_actuals?select=*').catch(() => null),
    rest('GET', 'swaps?select=*&order=created_at.asc').catch(() => null),
    rest('GET', 'pickups?select=*&order=created_at.asc').catch(() => null),
    // null: supabase/checklist-status.sql has not been run yet.
    rest('GET', 'checklist_status?select=*').catch(() => null),
    // null: supabase/fuel-requests.sql has not been run yet.
    rest('GET', 'fuel_requests?select=*').catch(() => null),
  ]);
  return {
    sectors: sectors.map(toSector),
    roster,
    people,
    settings: settings?.[0] || null,
    prefs: prefs || [],
    defects: techlog ? techlog.map(toDefect) : null, // null: this database has no tech log table yet
    history: history || [],
    briefings: briefings || [],
    // null: this database is not watching the WorldFlight schedule yet.
    official: official ? official.map(toSector) : null,
    officialCheck: officialCheck?.[0] || null,
    actuals: actuals || [],
    swaps: swaps || [],
    // null: supabase/pickups.sql has not been run, so empty seats cannot be asked for.
    pickups,
    checklistStatus: checklistStatus || [],
    fuelRequests: fuelRequests || [],
  };
}

// fields: { flight, dep, arr, std, sta, route, notes }
export function saveSector(fields, sectorId) {
  return sectorId
    ? rest('PATCH', `sectors?id=eq.${id(sectorId)}`, fields)
    : rest('POST', 'sectors', fields);
}

export const deleteSector = (sectorId) => rest('DELETE', `sectors?id=eq.${id(sectorId)}`);

// Giving a sector away. Each of these checks for itself who is allowed to do
// it, so the app only ever reads the swaps table.
export const offerSector = (rosterId, reason) => rest('POST', 'rpc/offer_sector', { entry: rosterId, why: reason });
export const claimSwap = (swapId) => rest('POST', 'rpc/claim_swap', { swap: swapId });
export const withdrawSwap = (swapId) => rest('POST', 'rpc/withdraw_swap', { swap: swapId });

// Asking for an empty seat, from supabase/pickups.sql. Like swaps, these only
// change through the database functions.
// The current TAF for an airport, from supabase/weather.sql. Returns null when
// that file has not been run, so the app can simply leave the forecast out.
export async function fetchTaf(icao) {
  try {
    return await rest('POST', 'rpc/taf', { icao_code: icao });
  } catch (err) {
    if (/not find|does not exist|404/i.test(err.message)) return null;
    throw err;
  }
}

export const requestPickup = (sectorId, duty) => rest('POST', 'rpc/request_pickup', { sector: sectorId, seat: duty });
export const withdrawPickup = (pickupId) => rest('POST', 'rpc/withdraw_pickup', { pickup: pickupId });
export const decidePickup = (pickupId, agree, why = '', report = null) =>
  rest('POST', 'rpc/decide_pickup', { pickup: pickupId, agree, why, report });
export const decideSwap = (swapId, agree, why = '') => rest('POST', 'rpc/decide_swap', { swap: swapId, agree, why });

// Where this device wants notifications sent. One row per device.
export const savePushSubscription = (sub) =>
  rest('POST', 'push_subscriptions?on_conflict=endpoint', { ...sub, user_id: getSession()?.userId }, 'resolution=merge-duplicates');

export const deletePushSubscription = (endpoint) =>
  rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`);

// The times the flight deck stamped for a sector. One row per sector, so
// stamping the same sector again updates it.
// Deletes the off and on block times for one sector, or for every sector when
// sectorId is null, putting the schedule back on the published times.
export const clearActuals = (sectorId) =>
  rest('DELETE', sectorId ? `sector_actuals?sector_id=eq.${id(sectorId)}` : 'sector_actuals?sector_id=not.is.null');

export const saveActual = (sectorId, fields) =>
  rest(
    'POST',
    'sector_actuals?on_conflict=sector_id',
    { sector_id: sectorId, ...fields, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates',
  );

// Broadcasting that a checklist is complete (or no longer is), one row per
// checklist. Only the completion fact is shared; tick-by-tick progress stays
// on the device, in state.checks.
export const fetchChecklistStatus = () => rest('GET', 'checklist_status?select=*');

export const saveChecklistStatus = (checklistId, fields) =>
  rest(
    'POST',
    'checklist_status?on_conflict=checklist_id',
    { checklist_id: checklistId, ...fields, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates',
  );

// The pilot's revision of the imported OFP's fuel figures: extra fuel, an
// adjusted taxi allowance, a reason and a draft/submitted/accepted status.
// One row per sector, same upsert shape as saveActual/saveBriefing.
export const saveFuelRequest = (sectorId, fields) =>
  rest(
    'POST',
    'fuel_requests?on_conflict=sector_id',
    { sector_id: sectorId, ...fields, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates',
  );

// Rostering someone twice on a sector updates their existing entry.
export const saveRoster = (entry) =>
  rest('POST', 'roster?on_conflict=sector_id,user_id', entry, 'resolution=merge-duplicates');

export const deleteRoster = (rosterId) => rest('DELETE', `roster?id=eq.${id(rosterId)}`);

export const updateProfile = (userId, fields) => rest('PATCH', `profiles?id=eq.${id(userId)}`, fields);

// Makes an account for somebody, from supabase/accounts.sql. Nobody signs
// themselves up. Returns { email, password } to pass on to them: a placeholder
// address they replace with their own the first time they sign in.
export const createAccount = (name, role, password) =>
  rest('POST', 'rpc/create_account', { display_name: name, account_role: role, temp_password: password });

// That first sign-in: their own email, and a password only they know.
export const finishSetup = (email, password) =>
  rest('POST', 'rpc/finish_setup', { new_email: email, new_password: password });

// Deletes a real account for good: rejects a sign-up, or removes a member.
export const removeAccount = (userId) => rest('POST', 'rpc/remove_account', { target: userId });

export const setRole = (userId, role) => rest('POST', 'rpc/set_role', { target: userId, new_role: role });

// ---- Roster state, rules and availability ----

// fields: any of { roster_state, rules, simbrief }
export const saveSettings = (fields) => rest('PATCH', 'settings?id=eq.1', fields);

// rows: [{ user_id, sector_id, choice }]
export const savePrefs = (rows) =>
  rest('POST', 'preferences?on_conflict=user_id,sector_id', rows, 'resolution=merge-duplicates');

export const deletePref = (userId, sectorId) =>
  rest('DELETE', `preferences?user_id=eq.${id(userId)}&sector_id=eq.${id(sectorId)}`);

// entries: complete roster rows, all with the same fields
export const saveRosterMany = (entries) =>
  rest('POST', 'roster?on_conflict=sector_id,user_id', entries, 'resolution=merge-duplicates');

export const clearAutoRoster = () => rest('DELETE', 'roster?auto=is.true');

// Empties the roster for the sectors given, whoever put each person there and
// however they were rostered. Any offer of a sector goes with the entry it was
// made against.
export const clearRosterFor = (sectorIds) =>
  sectorIds.length ? rest('DELETE', `roster?sector_id=in.(${sectorIds.map(id).join(',')})`) : Promise.resolve();

// ---- Briefings ----

// fields: any of { notes, wf_url, wf_notes, handover, ofp, ofp_by, ofp_at }.
// Only the fields given are changed; the rest of the sector's briefing is kept.
export const saveBriefing = (sectorId, fields) =>
  rest(
    'POST',
    'briefings?on_conflict=sector_id',
    { sector_id: sectorId, ...fields, updated_at: new Date().toISOString() },
    'resolution=merge-duplicates',
  );

// ---- Tech log ----

// The database numbers new entries (WF-001, WF-002, ...).
export const saveDefect = (defect, defectId) =>
  defectId ? rest('PATCH', `techlog?id=eq.${id(defectId)}`, fromDefect(defect)) : rest('POST', 'techlog', fromDefect(defect));

export const deleteDefect = (defectId) => rest('DELETE', `techlog?id=eq.${id(defectId)}`);

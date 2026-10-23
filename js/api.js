// Talks to the team's Supabase project: sign-in, and the shared schedule,
// roster and account list. Plain fetch calls, so there is nothing to install.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const BASE = SUPABASE_URL.trim().replace(/\/+$/, '');
const SESSION_KEY = 'qfa100-ops.session';

// False until config.js has been filled in; the app then runs in preview mode.
export const configured = !!(BASE && SUPABASE_ANON_KEY.trim());

// The saved sign-in. Read back from storage rather than kept only in memory,
// so closing the app - or leaving it closed for a fortnight - does not end it.
function stored() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    // no usable saved session
    return null;
  }
}

let session = stored();

// Ask the browser not to throw this away when it is short of room. Granted
// silently for an installed app; a plain tab may be refused, and on iOS Safari
// a site that is not on the home screen loses its storage after a week idle,
// which is the one case no amount of caching here can survive.
if (session && navigator.storage?.persist) navigator.storage.persist().catch(() => {});

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
    // A refresh reply without the account on it leaves who it is as it was.
    userId: data.user?.id ?? session?.userId,
    email: data.user?.email ?? session?.email,
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
  if (!fresh()) await refresh();
  await account('PUT', session.access, { password });
}

export async function signOut() {
  const token = session?.access;
  setSession(null);
  if (token) await auth('logout', {}, token).catch(() => {});
}

// Keeping the sign-in alive. The access token lasts an hour; the refresh token
// behind it does not run out, so a sign-in only ends when somebody signs out,
// an admin removes the account, or the device loses its storage.
//
// Supabase hands back a new refresh token every time one is used and retires
// the old one shortly after, so this has to be careful: the session is thrown
// away only when the server says the token itself is finished. A rate limit, a
// server error or a captive-portal page is not the end of a sign-in, and used
// to be treated as one - which is why the app asked for a password again after
// sitting unopened.
const spent = (err) =>
  [400, 401, 403].includes(err.status) && /refresh.?token|invalid.?grant|revoked/i.test(err.message || '');

const EARLY = 5 * 60 * 1000; // renew this far ahead of the hour running out

// True while the access token on hand is good enough to send.
const fresh = () => !!session && session.expiresAt - Date.now() > 60000;

async function renew() {
  // Another copy of the app, in another tab, may have rotated the token since
  // this one read it; what is in storage is always the newer of the two.
  const saved = stored();
  if (saved?.refresh && saved.refresh !== session?.refresh) {
    session = saved;
    // That tab has just renewed, so there is no need to spend a token here too.
    if (fresh()) return;
  }
  if (!session?.refresh) {
    setSession(null);
    throw new Error('Not signed in');
  }
  try {
    keep(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh }));
  } catch (err) {
    // "Already used": another tab beat us to it and has stored the session it
    // was given, so carry on with that one.
    const now = stored();
    if (now?.refresh && now.refresh !== session.refresh) {
      session = now;
      return;
    }
    if (spent(err)) setSession(null);
    throw err;
  }
}

let refreshing = null;
function refresh() {
  refreshing ??= renew().finally(() => (refreshing = null));
  return refreshing;
}

// Called when the app starts, comes back to the front and comes back online:
// the token is renewed before anything asks for data, rather than fifteen
// requests all discovering at once that it has run out. Failure here is quiet
// on purpose - the sign-in is kept and the next attempt tries again.
export async function keepSignedIn() {
  if (!session || session.expiresAt - Date.now() > EARLY) return;
  await refresh().catch(() => {});
}

async function rest(method, path, body, prefer) {
  if (!session) throw new Error('Not signed in');
  if (!fresh()) await refresh();
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

// The ops thread is read newest-first and turned back the right way round, so
// a long WorldFlight week does not drag the whole history down the wire every
// ten seconds.
const OPS_CHAT = 'ops_messages?select=*&order=sent_at.desc&limit=200';

export async function loadAll() {
  // Settings and availability arrived in a later database version; if the
  // database has not been updated yet, carry on without them.
  const [sectors, roster, people, settings, prefs, techlog, history, briefings, official, officialCheck, actuals, swaps, pickups, checklistStatus, normalChecklists, opsShifts, opsDesk, opsChat] =
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
    // null: supabase/normal-checklists.sql has not been run, so the team
    // cannot edit its checklists and everyone flies the bundled ones.
    rest('GET', 'normal_checklists?select=*&order=position.asc').catch(() => null),
    // null for these three: supabase/ops-chat.sql has not been run, so there
    // is no ops desk and no thread, and the app simply leaves the panel out.
    rest('GET', 'ops_shifts?select=*&order=starts_at.asc').catch(() => null),
    rest('GET', 'ops_desk?select=*&id=eq.1').catch(() => null),
    rest('GET', OPS_CHAT).catch(() => null),
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
    // null means this database has no table for them, so there is nothing to
    // edit; [] means the team simply has not changed anything yet. Both fly
    // the bundled checklists, but only the second can be edited, so the
    // difference is kept rather than flattened.
    normalChecklists,
    // null means no ops desk in this database; [] would mean an empty one, and
    // the difference is what decides whether the chat panel exists at all.
    opsShifts,
    opsDesk: opsDesk === null ? null : opsDesk[0] || null,
    opsChat: opsChat && [...opsChat].reverse(),
  };
}

// ---- The ops desk ----

export const fetchOpsChat = () => rest('GET', OPS_CHAT).then((rows) => [...rows].reverse());

// Who sent it, and when, are stamped by the database (see ops-chat.sql), so
// only the words go up.
export const sendOpsMessage = (body) => rest('POST', 'ops_messages', { body });

export const deleteOpsMessage = (messageId) => rest('DELETE', `ops_messages?id=eq.${id(messageId)}`);

// The shift roster, kept in Admin. fields: { user_id, starts_at, ends_at, notes }
export const saveOpsShift = (fields, shiftId) =>
  shiftId ? rest('PATCH', `ops_shifts?id=eq.${id(shiftId)}`, fields) : rest('POST', 'ops_shifts', fields);

export const deleteOpsShift = (shiftId) => rest('DELETE', `ops_shifts?id=eq.${id(shiftId)}`);

// Stepping in off the roster, and handing the desk back to it.
export const takeOpsDesk = () => rest('POST', 'rpc/take_ops_desk', {});
export const releaseOpsDesk = () => rest('POST', 'rpc/release_ops_desk', {});

// The doorbell for a call: a notification to the other side, for a phone with
// the app shut, which cannot be rung any other way.
export const ringOps = (callId) => rest('POST', 'rpc/ring_ops', { call_id: callId });

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

// The normal checklists the team has made its own, in the order they are
// flown. An empty list means nobody has changed them and every device uses
// the ones the app ships with. See supabase/normal-checklists.sql.
export const fetchNormalChecklists = () => rest('GET', 'normal_checklists?select=*&order=position.asc');

// The whole list goes in one call, so a reorder or a deletion cannot
// half-apply. The database refuses anyone who is not an admin.
export const putNormalChecklists = (list) => rest('POST', 'rpc/set_normal_checklists', { payload: list });

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

// ---- vPilot ----
// The radio on the pilot's PC, mirrored by a plugin inside vPilot (see
// supabase/vpilot.sql). Read on its own rather than in loadAll: it is live
// while a flight is on and of no interest at all the rest of the time.

// Read newest-first and turned back the right way round, like the ops thread.
const VPILOT_WINDOW = 'vpilot_messages?select=*&order=at.desc&limit=200';

// The bridge's simulator document, shared with every flight deck device.
export const fetchSimStatus = () =>
  rest('GET', 'sim_status?select=status&id=eq.1').then((rows) => rows?.[0]?.status || null);

// null for link means supabase/vpilot.sql has not been run, so the app leaves
// vPilot out altogether.
export async function fetchVpilot() {
  const [link, messages, controllers] = await Promise.all([
    rest('GET', 'vpilot_link?select=*&id=eq.1').catch(() => null),
    rest('GET', VPILOT_WINDOW).catch(() => null),
    rest('GET', 'vpilot_controllers?select=*&order=callsign.asc').catch(() => null),
  ]);
  return {
    link: link === null ? null : link[0] || null,
    messages: messages ? [...messages].reverse() : [],
    controllers: controllers || [],
  };
}

// Queues one command for vPilot and hands back its id. vPilot's own answer
// lands on that row a moment later - see fetchVpilotResult.
export const vpilotCommand = (kind, args = {}) => rest('POST', 'rpc/vpilot_command', { kind, args });

export const fetchVpilotResult = (seq) =>
  rest('GET', `vpilot_commands?select=ok,error,result_at&seq=eq.${id(seq)}`).then((rows) => rows?.[0] || null);

// Makes the plugin resend everything it knows.
export const vpilotResync = () => rest('POST', 'rpc/vpilot_resync', {});

// Lets a different vPilot install claim the EFB (admin only).
export const vpilotForgetPlugin = () => rest('POST', 'rpc/vpilot_forget_plugin', {});

// ---- ACARS ----
// The datalink station on the sim PC: Hoppie telex and CPDLC, and the receipt
// printer (supabase/acars.sql). Read like vPilot - live while a flight is on
// and of no interest the rest of the time - and driven through the same
// command queue, so there is one path from the EFB to that PC.

const ACARS_WINDOW = 'acars_messages?select=*&order=at.desc&limit=200';

// null for state means supabase/acars.sql has not been run, so the app leaves
// ACARS out altogether.
export async function fetchAcars() {
  const [state, messages] = await Promise.all([
    rest('GET', 'acars_state?select=*&id=eq.1').catch(() => null),
    rest('GET', ACARS_WINDOW).catch(() => null),
  ]);
  return {
    state: state === null ? null : state[0] || null,
    messages: messages ? [...messages].reverse() : [],
  };
}

// ACARS commands go down the same queue as vPilot's: the bridge routes them
// by their "acars-" prefix, and vpilot_command checks them against what the
// bridge actually understands before anything is queued.
export const acarsCommand = (kind, args = {}) => vpilotCommand(kind, args);

// Whether a Hoppie logon code is set, and who set it - never the code itself.
// Nothing in the database hands the code back to a browser.
export const fetchAcarsLogon = () =>
  rest('POST', 'rpc/acars_logon_status', {}).then((rows) => rows?.[0] || null);

// Sets the Hoppie logon code, the ACARS callsign, or the on/off switch
// (admin only). Leave the code out to change the others without retyping it.
export const setAcarsLogon = (args) => rest('POST', 'rpc/acars_set_logon', args);

export const forgetAcarsLogon = () => rest('POST', 'rpc/acars_forget_logon', {});

// A company message from ops to the flight deck. Not a queued command: it is
// written straight into the message window both sides read, and the printer
// is asked separately, so it works with the simulator PC switched off.
export const sendAcarsCompany = (message) =>
  rest('POST', 'rpc/acars_send_company', { message });

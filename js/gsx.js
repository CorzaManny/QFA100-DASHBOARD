import { fetchGsx, vpilotCommand, fetchVpilotResult } from './api.js';

let row = null;
let fault = '';
let reading = null;
let timer = null;
const watchers = new Set();
export const gsxPicture = () => ({ row, fault });
export const gsxOnline = () => !!row?.connected && Date.now() - Date.parse(row.updated_at) < 15000;

export async function syncGsx() {
  if (reading) return reading;
  reading = (async () => {
    try { row = await fetchGsx(); fault = ''; }
    catch (e) { row = null; fault = e.message || 'Unable to read GSX. Check that supabase/gsx.sql has been applied.'; }
    finally { reading = null; for (const fn of watchers) fn(); }
  })();
  return reading;
}
export function watchGsx(fn) {
  watchers.add(fn);
  if (!timer) { timer = setInterval(syncGsx, 2000); syncGsx(); }
  return () => { watchers.delete(fn); if (!watchers.size) { clearInterval(timer); timer = null; } };
}
export async function gsxCommand(type, args = {}) {
  if (!gsxOnline()) return { ok: false, error: 'GSX is disconnected or its status is stale.' };
  try {
    const seq = await vpilotCommand(type, args);
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const result = await fetchVpilotResult(seq);
      if (result?.result_at) return result;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, error: 'No answer from the bridge. Check GSX before trying again.' };
  } catch (e) { return { ok: false, error: e.message || 'GSX command failed.' }; }
}

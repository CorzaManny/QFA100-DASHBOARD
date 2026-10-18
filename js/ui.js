// Small shared helpers: escaping, UTC formatting, icons.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n) => String(n).padStart(2, '0');

export function zulu(t) {
  const d = new Date(t);
  return isNaN(d) ? '—' : `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

export function zdate(t) {
  const d = new Date(t);
  return isNaN(d) ? '—' : `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

// The simulator is a fixed-base sim in Sydney, so the only local time shown
// anywhere is Sydney's (AEDT during WorldFlight).
export const SIM_TZ = 'Australia/Sydney';
const simFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: SIM_TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

function simParts(t) {
  const d = new Date(t);
  if (isNaN(d)) return null;
  return Object.fromEntries(simFormat.formatToParts(d).map((p) => [p.type, p.value]));
}

// "SUN 0700 AEDT"
export function simLocal(t) {
  const p = simParts(t);
  return p ? `${p.weekday.toUpperCase()} ${p.hour}${p.minute} ${p.timeZoneName}` : '—';
}

// "0700 AEDT", for the header clock
export function simClock(t) {
  const p = simParts(t);
  return p ? `${p.hour}${p.minute} ${p.timeZoneName}` : '—';
}

// Hour of the day in sim local time, with minutes as a fraction (6.5 = 0630).
export function simHour(t) {
  const p = simParts(t);
  return p ? Number(p.hour) + Number(p.minute) / 60 : 0;
}

// The sim-local calendar day as a whole number, for counting days apart.
const simDate = new Intl.DateTimeFormat('en-CA', { timeZone: SIM_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export function simDay(t) {
  return Math.round(Date.parse(`${simDate.format(new Date(t))}T00:00:00Z`) / 86400000);
}

// Values for <input type="date"> / <input type="time">, in UTC.
export const isoDate = (t) => new Date(t).toISOString().slice(0, 10);
export const isoTime = (t) => new Date(t).toISOString().slice(11, 16);

// "2000Z–2200Z" for sectors that have a departure window rather than a fixed
// time. The window opens at std.
export function depWindow(sector) {
  if (!sector.window) return '';
  const t = new Date(sector.std).getTime();
  return `${zulu(t)}–${zulu(t + sector.window * 60000)}`;
}

export function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}

export function ago(t) {
  return `${span(Date.now() - t)} ago`;
}

export const icao = (s) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

export function rerender() {
  window.dispatchEvent(new Event('app:render'));
}

const PATHS = {
  deck: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  checks: '<path d="M3 5l2 2 3-3M3 12l2 2 3-3M3 19l2 2 3-3M12 6h9M12 13h9M12 20h9"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  pin: '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  settings:
    '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  plane:
    '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  alert: '<path d="M12 4l9.5 16h-19zM12 10v4M12 17.5v.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  share: '<path d="M12 3v12M8.5 6.5 12 3l3.5 3.5"/><path d="M7 10H5.5A1.5 1.5 0 0 0 4 11.5v8A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 10H17"/>',
  plus_square: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// The Minimum Equipment List: what the aircraft may be dispatched with
// inoperative, on what conditions, and the (O) crew and (M) maintenance
// procedures that go with each item. The data is built from the team's
// 737-800 MEL by tools/build_mel.py.

const DAY = 86400000;

let mel = null;
let loading = null;

export function loadMel() {
  loading ??= fetch('js/data/mel.json')
    .then((r) => r.json())
    .then((data) => (mel = index(data)))
    .catch(() => (loading = null));
  return loading;
}

export const melReady = () => !!mel;
export const melSource = () => mel?.source || '';

// "21-01-01-02A" belongs to the item "21-01".
const topOf = (id) => id.split('-').slice(0, 2).join('-').replace(/[A-Z]$/, '');
const parentOf = (id) => (/[A-Z]$/.test(id) ? id.slice(0, -1) : id.split('-').length > 2 ? id.slice(0, id.lastIndexOf('-')) : null);

function index(data) {
  const byId = new Map(data.items.map((e) => [e.id, e]));
  // Only entries with a repair category give dispatch relief; the rest are headings.
  const options = new Map();
  for (const e of data.items) {
    if (!e.cat) continue;
    const top = topOf(e.id);
    if (!options.has(top)) options.set(top, []);
    options.get(top).push(e);
  }
  const tops = data.items.filter((e) => e.id === topOf(e.id) && options.has(e.id));
  // For searching: each option's item name, then its number and headings, then its conditions.
  const search = [...options.values()].flat().map((e) => {
    const path = pathIn(byId, e.id);
    return [e, (path[0] || '').toLowerCase(), `${e.id} ${path.join(' ')}`.toLowerCase(), e.rem.toLowerCase()];
  });
  const chapters = data.chapters.filter((c) => tops.some((t) => t.id.startsWith(`${c.ata}-`)));
  return { source: data.source, chapters, byId, options, tops, search, procs: data.procs || {} };
}

export const chapters = () => mel?.chapters || [];
export const chapterLabel = (c) => `${c.ata} · ${c.title}`;
export const chapterByLabel = (label) => chapters().find((c) => chapterLabel(c) === label) || null;
export const melEntry = (id) => mel?.byId.get(id) || null;
export const melItems = (ata) => (mel ? mel.tops.filter((t) => t.id.startsWith(`${ata}-`)) : []);
export const melOptions = (topId) => mel?.options.get(topId) || [];
export const melTop = (id) => (id ? topOf(id) : '');

// The headings above an entry, outermost first: ["Air Conditioning Packs", "All-Passenger Configuration", ...].
export const melPath = (id) => (mel ? pathIn(mel.byId, id) : []);

function pathIn(byId, id) {
  const out = [];
  for (let key = id; key; key = parentOf(key)) {
    const e = byId.get(key);
    if (e?.title) out.unshift(e.title);
  }
  return out;
}

// Notes printed against the headings above an entry, which apply to everything under them.
export function melNotes(id) {
  const out = [];
  for (let key = parentOf(id); key; key = parentOf(key)) {
    const e = mel?.byId.get(key);
    if (e && !e.cat && e.rem) out.unshift(e.rem);
  }
  return out;
}

export const PROCEDURES = {
  o: '(O) Crew procedure',
  m: '(M) Maintenance procedure',
  on: 'Operations note',
  mn: 'Maintenance note',
  n: 'Notes',
};

// The procedures for an entry: { from, sections: [[kind, text]] }. Some are
// written once for a whole item, so look up the headings when the entry has none.
export function melProcedures(id) {
  const entry = melEntry(id);
  for (let key = id; key; key = parentOf(key)) {
    const sections = mel?.procs[key];
    if (sections) return { from: key, sections };
    if (!entry?.m && !entry?.o) break;
  }
  return null;
}

// Entries matching every word typed: matches in the item's name first, then
// in its headings, then in the conditions.
export function searchMel(query, limit = 20) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!mel || query.trim().length < 2) return [];
  const out = [];
  for (const [e, item, name, text] of mel.search) {
    if (words.every((w) => item.includes(w))) out.push([0, e]);
    else if (words.every((w) => name.includes(w))) out.push([1, e]);
    else if (words.every((w) => name.includes(w) || text.includes(w))) out.push([2, e]);
  }
  return out
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map((x) => x[1]);
}

// What tells one option of an item from another.
export function optionLabel(entry) {
  const own = melPath(entry.id).slice(1).join(' › ');
  const letter = /[A-Z]$/.test(entry.id) ? `Option ${entry.id.slice(-1)}` : '';
  const text = [own, letter].filter(Boolean).join(' · ') || 'Whole item';
  return `${entry.id} · ${text}`;
}

// How long a deferred defect may stay open, by repair category.
export const CATEGORIES = {
  A: { days: 0, text: 'Fix within the time stated in the conditions' },
  B: { days: 3, text: 'Fix within 3 days' },
  C: { days: 10, text: 'Fix within 10 days' },
  D: { days: 120, text: 'Fix within 120 days' },
};

// The day of discovery does not count, so the limit runs from the end of that day (Zulu).
export function dueFor(cat, at) {
  const days = CATEGORIES[cat]?.days;
  if (!days) return null;
  return Math.floor(at / DAY) * DAY + (days + 1) * DAY - 60000;
}

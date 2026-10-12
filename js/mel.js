// The Minimum Equipment List: what the aircraft may be dispatched with
// inoperative, and on what conditions. The data is built from the FAA Boeing
// 737 MMEL by tools/build_mel.py, cut down to a passenger 737-800.

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
  const chapters = data.chapters.filter((c) => tops.some((t) => t.id.startsWith(`${c.ata}-`)));
  return { source: data.source, chapters, byId, options, tops };
}

export const chapters = () => mel?.chapters || [];
export const chapterLabel = (c) => `${c.ata} · ${c.title}`;
export const chapterByLabel = (label) => chapters().find((c) => chapterLabel(c) === label) || null;
export const melEntry = (id) => mel?.byId.get(id) || null;
export const melItems = (ata) => (mel ? mel.tops.filter((t) => t.id.startsWith(`${ata}-`)) : []);
export const melOptions = (topId) => mel?.options.get(topId) || [];
export const melTop = (id) => (id ? topOf(id) : '');

// The headings above an entry, outermost first: ["Air Conditioning Packs", "All-Passenger Configuration", ...].
export function melPath(id) {
  const out = [];
  for (let key = id; key; key = parentOf(key)) {
    const e = mel?.byId.get(key);
    if (e?.title) out.unshift(e.title);
  }
  return out;
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

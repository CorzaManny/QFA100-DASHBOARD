// The flight deck's notepad: a pad that pulls out over the right edge on any
// page, for a clearance, a frequency or a runway change written down in the
// moment.
//
// Like the two chat panels it is a panel rather than a page, because nothing
// written down in a cockpit waits for somebody to navigate somewhere, and it
// docks over the same right edge - only one of the three is ever out at a
// time, see the 'app:panel' event below and js/app.js.
//
// What is drawn is kept on the device, in localStorage beside the account that
// drew it, not in the team database: a scratchpad is the tablet's own paper,
// and the two tablets have no use for each other's.

import { icon } from './ui.js';
import { isEfb } from './ops.js';
import { getSession } from './api.js';

const OPEN_KEY = 'qfa100-scratch-open';
const WIDTH_KEY = 'qfa100-scratch-width';
// One pad per account, so the Captain and First Officer tablets keep their own
// paper even on a browser that has been signed in as both.
const padKey = (userId) => (userId ? `qfa100-scratch.v1.${userId}` : 'qfa100-scratch.v1');

// Literal colours rather than CSS variables: a stroke is stored with the
// colour it was drawn in, and a redraw months later should not depend on what
// --accent happens to be by then.
const INKS = [
  { id: 'white', css: '#ffffff', label: 'White ink' },
  { id: 'red', css: '#e4002b', label: 'Red ink' },
  { id: 'amber', css: '#f0a63c', label: 'Amber ink' },
  { id: 'blue', css: '#4f9bf0', label: 'Blue ink' },
];
const NIBS = [
  { id: 'fine', w: 2, label: 'Fine nib' },
  { id: 'medium', w: 4, label: 'Medium nib' },
  { id: 'broad', w: 8, label: 'Broad nib' },
];
// How wide the pad may be dragged. Narrower than this and there is no room to
// write; wider and there is no page left beside it.
const MIN_W = 300;
const MAX_W = 760;

const panel = document.getElementById('scratchpanel');
const toggle = document.getElementById('scratch-toggle');
const tools = document.getElementById('scratch-tools');
const sheet = document.getElementById('scratch-sheet');
const hint = document.getElementById('scratch-hint');
const canvas = document.getElementById('scratch-canvas');
const grip = document.getElementById('scratch-grip');
const ctx = canvas.getContext('2d');

let open = false;
try {
  // Closed until asked for: the pad is paper waiting to be picked up, not
  // something to sit over the page until it is put away.
  open = localStorage.getItem(OPEN_KEY) === '1';
} catch {
  // storage unavailable; start closed
}

let ink = INKS[0];
let nib = NIBS[1];
let erasing = false;
let strokes = []; // what is on the pad: { c, w, erase, pen, pts: [[x, y, pressure]] }
let loaded = null; // the pad key the strokes above came from
let full = false; // the device would not store the pad - see keep() below
// A tablet with a stylus should not draw with the palm resting on the glass,
// so once a pen has been seen, fingers stop drawing on this device.
let penSeen = false;
let drawing = null; // the stroke under the pointer, while one is down
let pointer = null; // which pointer is drawing it

// ---- The sheet ----
// Strokes are stored as a fraction of the pad's width, with y in those same
// units, so the pad keeps its proportions and what was written at 340px wide
// comes back the same shape after the panel is dragged wider or the tablet is
// turned on its side.

const size = () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 });

// What a point should be drawn at, in CSS pixels.
const at = (pt, scale) => [pt[0] * scale, pt[1] * scale];

// A pen that is pressed harder draws a wider line; a finger or a mouse draws
// an even one, because neither has anything honest to say about pressure.
const width = (stroke, pressure) => {
  const w = stroke.erase ? stroke.w * 4 : stroke.w;
  return stroke.pen ? w * (0.45 + 1.1 * pressure) : w;
};

function segment(stroke, a, b, scale) {
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.erase ? '#000' : stroke.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The nib is sized from the far end of the segment, so a stroke that is
  // pressed harder as it goes thickens along its length. It is a nib width in
  // pixels, not a fraction of the pad: dragging the pad wider should give more
  // room to write, not a fatter pen.
  ctx.lineWidth = Math.max(0.5, width(stroke, b[2] ?? 0.5));
  ctx.beginPath();
  const [ax, ay] = at(a, scale);
  const [bx, by] = at(b, scale);
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

function paintStroke(stroke, scale) {
  const pts = stroke.pts;
  if (pts.length === 1) {
    // A tap is a dot, not nothing.
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.fillStyle = stroke.erase ? '#000' : stroke.c;
    const [x, y] = at(pts[0], scale);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, width(stroke, pts[0][2] ?? 0.5) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < pts.length; i += 1) segment(stroke, pts[i - 1], pts[i], scale);
}

// The canvas is sized to the panel in device pixels, so a stylus line is as
// sharp as the screen allows rather than being blown up from CSS pixels.
function fit() {
  const { w, h } = size();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const nw = Math.max(1, Math.round(w * dpr));
  const nh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== nw || canvas.height !== nh) {
    canvas.width = nw;
    canvas.height = nh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function redraw() {
  fit();
  const { w, h } = size();
  ctx.clearRect(0, 0, w, h);
  for (const stroke of strokes) paintStroke(stroke, w);
  ctx.globalCompositeOperation = 'source-over';
}

// ---- Keeping the pad ----

let pending = 0;

function keep() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    const was = full;
    try {
      localStorage.setItem(loaded, JSON.stringify({ v: 1, strokes }));
      full = false;
    } catch {
      // A pad drawn on for hours can outgrow what the device will store. What
      // is on screen is untouched; the crew is told it will not survive a
      // reload, which is their cue to clear it.
      full = true;
    }
    if (full !== was) paintTools();
  }, 400);
}

function pick(userId) {
  const key = padKey(userId);
  if (key === loaded) return;
  loaded = key;
  strokes = [];
  full = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved?.strokes)) {
      strokes = saved.strokes.filter((s) => Array.isArray(s?.pts) && s.pts.length);
    }
  } catch {
    // unreadable or blocked storage: start on a clean sheet
  }
  redraw();
}

// ---- The toolbar ----

// sel is null for the buttons that do something rather than being picked up:
// aria-pressed on those would announce Undo as a switch that is turned off.
const chip = (sel, extra, inner, label, act) =>
  `<button type="button" class="scratch-chip${extra}" data-pad="${act}"${
    sel === null ? '' : ` aria-pressed="${sel}"`
  } aria-label="${label}" title="${label}">${inner}</button>`;

function paintTools() {
  const inks = INKS.map((i) =>
    chip(
      String(!erasing && i.id === ink.id),
      ' scratch-ink',
      `<span class="scratch-swatch" style="background:${i.css}"></span>`,
      i.label,
      `ink:${i.id}`,
    ),
  ).join('');
  const nibs = NIBS.map((n) =>
    chip(
      String(n.id === nib.id),
      ' scratch-nib',
      `<span class="scratch-dot" style="width:${n.w + 3}px;height:${n.w + 3}px"></span>`,
      n.label,
      `nib:${n.id}`,
    ),
  ).join('');
  tools.innerHTML = `
    <div class="scratch-group">${inks}</div>
    <div class="scratch-group">${nibs}</div>
    <div class="scratch-group">
      ${chip(String(erasing), '', icon('eraser'), 'Eraser', 'erase')}
      ${chip(null, '', icon('undo'), 'Undo the last stroke', 'undo')}
      ${chip(null, '', icon('trash'), 'Clear the pad', 'clear')}
      ${chip(null, '', icon('download'), 'Save the pad as an image', 'save')}
    </div>
    ${full ? `<p class="note warn scratch-note">${icon('alert')} No room left on this device to keep the pad. Save it as an image, then clear it.</p>` : ''}`;
  for (const el of tools.querySelectorAll('[data-pad^="undo"], [data-pad^="clear"], [data-pad^="save"]')) {
    el.disabled = !strokes.length;
  }
  hint.hidden = !!strokes.length;
}

// ---- Drawing ----

function point(e) {
  const box = canvas.getBoundingClientRect();
  const scale = box.width || 1;
  const p = e.pointerType === 'pen' ? Math.min(Math.max(e.pressure || 0.5, 0.05), 1) : 0.5;
  // Four decimals is a fifth of a pixel on the widest the pad can be dragged,
  // and keeps a long pad small enough for the device to store.
  return [
    Number(((e.clientX - box.left) / scale).toFixed(4)),
    Number(((e.clientY - box.top) / scale).toFixed(4)),
    Number(p.toFixed(2)),
  ];
}

// Every point the pointer actually passed through, not just the one the
// browser got round to telling us about: a stylus moved quickly would
// otherwise draw as a row of straight lines between widely spaced samples.
const samples = (e) => (e.getCoalescedEvents ? e.getCoalescedEvents() : []).filter((s) => s.clientX != null);

canvas.addEventListener('pointerdown', (e) => {
  if (!open || drawing) return;
  if (e.pointerType === 'pen') penSeen = true;
  else if (penSeen && e.pointerType === 'touch') return; // a palm resting on the glass
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  pointer = e.pointerId;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // capture is a nicety: without it a stroke simply ends at the pad's edge
  }
  drawing = { c: ink.css, w: nib.w, erase: erasing, pen: e.pointerType === 'pen', pts: [point(e)] };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== pointer) return;
  e.preventDefault();
  const scale = size().w;
  const trail = samples(e);
  for (const s of trail.length ? trail : [e]) {
    const pt = point(s);
    const prev = drawing.pts.at(-1);
    // A pointer that has not really moved is not a new point; it only makes
    // the pad bigger to store.
    if (Math.abs(pt[0] - prev[0]) + Math.abs(pt[1] - prev[1]) < 0.0015) continue;
    drawing.pts.push(pt);
    segment(drawing, prev, pt, scale);
  }
});

function finish(e) {
  if (!drawing || (e && e.pointerId !== pointer)) return;
  const stroke = drawing;
  drawing = null;
  pointer = null;
  strokes.push(stroke);
  // A tap left only one point, which nothing has drawn yet.
  if (stroke.pts.length === 1) paintStroke(stroke, size().w);
  ctx.globalCompositeOperation = 'source-over';
  keep();
  paintTools();
}

canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);
canvas.addEventListener('lostpointercapture', finish);

// ---- The tools themselves ----

// The pad as a PNG, on the flight deck's own background rather than the
// transparent sheet it is drawn on, so it is readable wherever it ends up.
function download() {
  if (!strokes.length) return;
  const { w, h } = size();
  const dpr = 2;
  const out = document.createElement('canvas');
  out.width = Math.round(w * dpr);
  out.height = Math.round(h * dpr);
  const octx = out.getContext('2d');
  octx.fillStyle = '#080d13';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0, out.width, out.height);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const a = document.createElement('a');
  a.href = out.toDataURL('image/png');
  a.download = `qfa100-scratchpad-${stamp}Z.png`;
  a.click();
}

function undo() {
  if (!strokes.length) return;
  strokes.pop();
  redraw();
  keep();
  paintTools();
}

function clear() {
  if (!strokes.length) return;
  if (!confirm('Clear everything on the scratchpad?')) return;
  strokes = [];
  redraw();
  keep();
  paintTools();
}

const acts = {
  erase: () => {
    erasing = !erasing;
    paintTools();
  },
  undo,
  clear,
  save: download,
};

tools.addEventListener('click', (e) => {
  const act = e.target.closest('[data-pad]')?.dataset.pad;
  if (!act) return;
  const [name, arg] = act.split(':');
  if (name === 'ink') {
    ink = INKS.find((i) => i.id === arg) || ink;
    // Picking up a colour puts the eraser down.
    erasing = false;
    paintTools();
    return;
  }
  if (name === 'nib') {
    nib = NIBS.find((n) => n.id === arg) || nib;
    paintTools();
    return;
  }
  acts[name]?.();
});

// ---- The panel ----

let padWidth = 0;
try {
  padWidth = Number(localStorage.getItem(WIDTH_KEY)) || 0;
} catch {
  // storage unavailable; the pad uses its standard width
}

function setWidth(px, remember) {
  padWidth = Math.round(Math.min(Math.max(px, MIN_W), Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - 120))));
  document.body.style.setProperty('--scratch-w', `${padWidth}px`);
  if (!remember) return;
  try {
    localStorage.setItem(WIDTH_KEY, String(padWidth));
  } catch {
    // storage unavailable; the width just will not be remembered next visit
  }
}
if (padWidth) setWidth(padWidth, false);

// Dragging the pad's left edge makes it wider. On a phone it is the whole
// screen anyway, and the grip is hidden there.
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    // capture is a nicety; the window listeners below do the work either way
  }
  const start = e.clientX;
  const from = panel.getBoundingClientRect().width;
  const move = (m) => {
    if (m.pointerId === e.pointerId) setWidth(from + (start - m.clientX), false);
  };
  const up = (m) => {
    if (m.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    // The width is only written down once the drag is finished, rather than at
    // every pixel along the way.
    setWidth(padWidth, true);
    redraw();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

export function setOpen(next) {
  open = next;
  try {
    localStorage.setItem(OPEN_KEY, next ? '1' : '0');
  } catch {
    // storage unavailable; the choice just will not be remembered
  }
  // Only one panel over the right edge at a time.
  if (next) window.dispatchEvent(new CustomEvent('app:panel', { detail: 'scratch' }));
  paint();
  // The pad was sized while it was off the side of the screen, so it is
  // measured again now that it is out.
  if (next) requestAnimationFrame(redraw);
}

// Rewrites the panel's chrome. What has been drawn is never touched: the
// canvas lives outside the page a render replaces, so a page change, a sync or
// a reload leaves the writing where it was.
export function paint() {
  const can = isEfb();
  document.body.classList.toggle('scratch', can);
  document.body.classList.toggle('scratch-open', can && open);
  if (!can) return;
  pick(getSession()?.userId);
  paintTools();
}

toggle.addEventListener('click', () => setOpen(true));
document.getElementById('scratch-close').addEventListener('click', () => setOpen(false));
window.addEventListener('app:panel', (e) => {
  if (e.detail !== 'scratch' && open) setOpen(false);
});

// A tablet turned on its side, or the pad dragged wider, keeps what is on it.
if (window.ResizeObserver) {
  let last = `${canvas.clientWidth}x${canvas.clientHeight}`;
  new ResizeObserver(() => {
    const now = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (now === last) return;
    last = now;
    redraw();
  }).observe(sheet);
} else {
  window.addEventListener('resize', redraw);
}

// Undo from the keyboard, for a tablet with a keyboard beside it and for
// anyone drawing with a mouse. Escape puts the pad away.
window.addEventListener('keydown', (e) => {
  if (!open || !isEfb()) return;
  if (e.key === 'Escape') {
    setOpen(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
});

// A pad that has just been drawn on should survive the tablet being closed
// before the save it was waiting on.
window.addEventListener('pagehide', () => {
  if (!pending || !loaded) return;
  clearTimeout(pending);
  try {
    localStorage.setItem(loaded, JSON.stringify({ v: 1, strokes }));
  } catch {
    // nothing more to be done at this point
  }
});

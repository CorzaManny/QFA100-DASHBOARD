import { esc } from './ui.js';
import { pdfSource } from './pdf-source.js';

const MIN_SCALE = .1;
const MAX_SCALE = 6;
const MAX_PIXELS = 12000000;
let renderer;
async function pdfLibrary() {
  renderer ||= import('../vendor/pdfjs/legacy/build/pdf.min.mjs');
  const pdfjs = await renderer;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

export function mountPdfViewer(host, url, title, updated = '') {
  host.innerHTML = `<div class="wf-pdf-controls" aria-label="PDF controls">
    <button class="btn ghost" data-pdf="previous" aria-label="Previous page" disabled>←</button>
    <label>Page <input data-pdf="page" type="number" min="1" value="1" aria-label="Page number" disabled></label><span data-pdf="pages">of —</span>
    <button class="btn ghost" data-pdf="next" aria-label="Next page" disabled>→</button>
    <span class="wf-pdf-divider"></span>
    <button class="btn ghost" data-pdf="out" aria-label="Zoom out" disabled>−</button>
    <label><input data-pdf="zoom" type="number" min="10" max="600" step="10" value="100" aria-label="Zoom percentage" disabled>%</label>
    <button class="btn ghost" data-pdf="in" aria-label="Zoom in" disabled>+</button>
    <button class="btn ghost" data-pdf="width" disabled>Fit width</button>
    <button class="btn ghost" data-pdf="fit" disabled>Fit page</button>
  </div><p class="wf-pdf-status" role="status">Loading briefing…</p>
  <div class="wf-pdf-viewport" tabindex="0" aria-label="Briefing page. Drag to pan; pinch or use the zoom controls to zoom.">
    <div class="wf-pdf-surface"><canvas role="img" aria-label="${esc(title)}"></canvas></div></div>`;
  const control = key => host.querySelector(`[data-pdf="${key}"]`);
  const viewport = host.querySelector('.wf-pdf-viewport');
  const surface = host.querySelector('.wf-pdf-surface');
  const canvas = host.querySelector('canvas');
  canvas.width = 0; canvas.height = 0;
  const status = host.querySelector('[role="status"]');
  let dead = false, loading, pdf, page, pageNumber = 1, scale = 1, fitMode = 'width';
  let renderTask, revision = 0, timer, pageRevision = 0;
  let pageWidth = 1, pageHeight = 1;
  const pointers = new Map();
  let gesture;
  const offset = () => Math.max(16, (viewport.clientWidth - pageWidth * scale) / 2);
  function layout() {
    canvas.style.width = `${pageWidth * scale}px`;
    canvas.style.height = `${pageHeight * scale}px`;
    canvas.style.left = `${offset()}px`;
    surface.style.width = `${pageWidth * scale + 32}px`;
    surface.style.height = `${pageHeight * scale + 32}px`;
    control('zoom').value = Math.round(scale * 100);
    control('out').disabled = scale <= MIN_SCALE;
    control('in').disabled = scale >= MAX_SCALE;
  }
  function paint() {
    clearTimeout(timer);
    const requested = ++revision;
    renderTask?.cancel();
    // Immediately resize the previous bitmap during gestures, then redraw it
    // sharply once the gesture settles. Bound memory for very large charts.
    timer = setTimeout(async () => {
      if (dead || !page) return;
      const currentPage = page;
      const density = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(MAX_PIXELS / (pageWidth * pageHeight * scale * scale)));
      const view = currentPage.getViewport({ scale: scale * density });
      const buffer = document.createElement('canvas');
      buffer.width = Math.ceil(view.width);
      buffer.height = Math.ceil(view.height);
      try {
        const task = currentPage.render({ canvasContext: buffer.getContext('2d'), viewport: view });
        renderTask = task;
        await task.promise;
        if (dead || requested !== revision) return;
        canvas.width = buffer.width; canvas.height = buffer.height;
        canvas.getContext('2d').drawImage(buffer, 0, 0);
        status.textContent = 'Drag to move around the page. Pinch or use + and − to zoom.';
      } catch (err) {
        if (!dead && requested === revision && err.name !== 'RenderingCancelledException')
          status.textContent = 'Unable to draw this page. Try another page or a lower zoom.';
      } finally { buffer.width = 0; buffer.height = 0; }
    }, 120);
  }
  function zoom(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    if (!page) return;
    const pointX = (viewport.scrollLeft + x - offset()) / scale;
    const pointY = (viewport.scrollTop + y - 16) / scale;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    layout();
    viewport.scrollLeft = pointX * scale + offset() - x;
    viewport.scrollTop = pointY * scale + 16 - y;
    paint();
  }
  function fit(mode) {
    fitMode = mode;
    const width = (viewport.clientWidth - 32) / pageWidth;
    const height = (viewport.clientHeight - 32) / pageHeight;
    zoom(mode === 'fit' ? Math.min(width, height) : width);
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  }
  async function go(number) {
    if (!pdf || dead) return;
    const next = Math.max(1, Math.min(pdf.numPages, Math.round(number) || 1));
    const requested = ++pageRevision;
    ++revision; renderTask?.cancel(); clearTimeout(timer);
    status.textContent = `Loading page ${next}…`;
    try {
      const loaded = await pdf.getPage(next);
      if (dead || requested !== pageRevision) return;
      page = loaded; pageNumber = next;
      const base = page.getViewport({ scale: 1 });
      pageWidth = base.width; pageHeight = base.height;
      canvas.width = 0; canvas.height = 0;
      canvas.setAttribute('aria-label', `${title}, page ${next} of ${pdf.numPages}`);
      control('page').value = next;
      control('previous').disabled = next === 1;
      control('next').disabled = next === pdf.numPages;
      if (fitMode) fit(fitMode);
      else { layout(); viewport.scrollLeft = 0; viewport.scrollTop = 0; paint(); }
    } catch { if (!dead) status.textContent = 'Unable to load this page. Please try again.'; }
  }
  host.addEventListener('click', event => {
    const action = event.target.closest('button[data-pdf]')?.dataset.pdf;
    if (action === 'previous') go(pageNumber - 1);
    if (action === 'next') go(pageNumber + 1);
    if (action === 'in' || action === 'out') { fitMode = null; zoom(scale * (action === 'in' ? 1.25 : .8)); }
    if (action === 'width' || action === 'fit') fit(action);
  });
  control('page').addEventListener('change', event => go(Number(event.target.value)));
  control('zoom').addEventListener('change', event => { fitMode = null; zoom((Number(event.target.value) || 100) / 100); });
  viewport.addEventListener('wheel', event => {
    if (!page || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault(); fitMode = null;
    const rect = viewport.getBoundingClientRect();
    zoom(scale * Math.exp(-event.deltaY * .01), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  function resetGesture() {
    const points = [...pointers.values()];
    gesture = points.length > 1 ? { distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), scale,
      x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : null;
  }
  viewport.addEventListener('pointerdown', event => {
    if (!page || event.button > 0) return;
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    resetGesture();
  });
  viewport.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      viewport.scrollLeft -= event.clientX - previous.x;
      viewport.scrollTop -= event.clientY - previous.y;
    } else if (gesture) {
      const points = [...pointers.values()];
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const rect = viewport.getBoundingClientRect();
      fitMode = null;
      zoom(gesture.scale * distance / Math.max(1, gesture.distance), gesture.x - rect.left, gesture.y - rect.top);
      resetGesture();
    }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, event => {
    pointers.delete(event.pointerId); resetGesture();
  });
  const observer = new ResizeObserver(() => { if (page && !dead) { if (fitMode) fit(fitMode); else layout(); } });
  observer.observe(viewport);
  (async () => {
    try {
      const pdfjs = await pdfLibrary();
      if (dead) return;
      const assets = new URL('../vendor/pdfjs/', import.meta.url).href;
      const source = await pdfSource(url, updated);
      if (dead) return;
      loading = pdfjs.getDocument({ url: source, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, isEvalSupported: false });
      pdf = await loading.promise;
      if (dead) return;
      host.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
      control('page').max = pdf.numPages;
      control('pages').textContent = `of ${pdf.numPages}`;
      await go(1);
    } catch (err) {
      if (dead) return;
      console.error('WorldFlight PDF failed to load:', url, err);
      status.textContent = 'Unable to load the zoomable briefing. Try the basic viewer below.';
      const fallback = document.createElement('button');
      fallback.className = 'btn ghost'; fallback.textContent = 'Use basic in-app viewer';
      status.append(' ', fallback);
      fallback.addEventListener('click', () => {
        host.innerHTML = `<iframe class="wf-document-frame" title="${esc(title)}" src="${esc(url)}" referrerpolicy="no-referrer"></iframe>`;
      });
    }
  })();
  return () => {
    dead = true; ++revision; ++pageRevision; clearTimeout(timer);
    observer.disconnect(); renderTask?.cancel();
    loading?.destroy().catch(() => {});
    canvas.width = 0; canvas.height = 0;
  };
}

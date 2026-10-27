import { esc } from './ui.js';

// Shared by airport and sector briefings. Keep the viewer outside the page
// root so live weather/flight updates cannot reload an open document.
export function documentButton(doc) {
  return `<button type="button" class="row wf-document-link" data-document-url="${esc(doc.url)}" data-document-name="${esc(doc.name || 'WorldFlight briefing')}" data-document-type="${esc(doc.type || '')}">`;
}

let viewer = null;
let previousFocus = null;

function closeViewer() {
  if (!viewer) return;
  viewer.close();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-document-url]');
  if (!button) return;
  let url;
  try { url = new URL(button.dataset.documentUrl); }
  catch { return; }
  if (!['https:', 'http:'].includes(url.protocol)) return;
  previousFocus = button;
  if (!viewer) {
    viewer = document.createElement('dialog');
    viewer.className = 'wf-document-viewer';
    viewer.setAttribute('aria-labelledby', 'wf-document-title');
    document.body.append(viewer);
    viewer.addEventListener('close', () => {
      viewer.replaceChildren();
      document.body.classList.remove('wf-document-open');
      if (previousFocus?.isConnected) previousFocus.focus();
    });
  }
  const title = button.dataset.documentName;
  const image = button.dataset.documentType.toUpperCase() === 'IMAGE' || /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
  viewer.innerHTML = `<header class="wf-document-toolbar"><div><div class="tiny">WORLDFLIGHT BRIEFING</div><h2 id="wf-document-title">${esc(title)}</h2></div>
    <button type="button" class="btn ghost" autofocus>Close briefing</button></header>
    ${image ? `<div class="wf-document-image"><img src="${esc(url.href)}" alt="${esc(title)}"></div>` :
      `<iframe class="wf-document-frame" title="${esc(title)}" src="${esc(url.href)}" referrerpolicy="no-referrer"></iframe>`}`;
  viewer.querySelector('button').addEventListener('click', closeViewer);
  document.body.classList.add('wf-document-open');
  viewer.showModal();
});

window.addEventListener('hashchange', closeViewer);

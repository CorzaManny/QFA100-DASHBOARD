// A locally served copy lets PDF.js read official PDFs whose host has no CORS.
// Match the published revision so we never silently substitute an older copy.
export async function pdfSource(url, updated = '') {
  const source = new URL(url, location.href);
  if (source.origin !== 'https://planning.worldflight.center' || !source.pathname.startsWith('/uploads/'))
    return source.href;
  try {
    const folder = new URL('../docs/worldflight/', import.meta.url);
    const response = await fetch(new URL('manifest.json', folder), { cache: 'no-cache' });
    if (!response.ok) return source.href;
    const entry = (await response.json())[source.href];
    if (!entry || !/^[A-Z0-9]{4}-[a-f0-9]{20}\.pdf$/.test(entry.file)) return source.href;
    if (updated && Date.parse(entry.updated) !== Date.parse(updated)) return source.href;
    return new URL(entry.file, folder).href;
  } catch { return source.href; }
}

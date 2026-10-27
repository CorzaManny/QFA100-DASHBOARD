// Refresh locally served WorldFlight PDFs to avoid the host's missing CORS headers.
// Run: node tools/cache_worldflight_docs.mjs [ICAO ...] (default: schedule airports).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const folder = new URL('docs/worldflight/', root);
const manifestUrl = new URL('manifest.json', folder);
const site = 'https://planning.worldflight.center';
const schedule = await readFile(new URL('js/data/schedule.js', root), 'utf8');
const requested = process.argv.slice(2);
const codes = requested.length ? requested.map(code => code.toUpperCase()) :
  [...new Set([...schedule.matchAll(/"(?:dep|arr)":\s*"([A-Z0-9]{4})"/g)].map(match => match[1]))];
if (codes.some(code => !/^[A-Z0-9]{4}$/.test(code))) throw new Error('Use four-character ICAO codes.');
await mkdir(folder, { recursive: true });
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestUrl, 'utf8')); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
let failures = 0, saved = 0;
async function response(url) {
  const reply = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
  if (!reply.ok) throw new Error(`HTTP ${reply.status}: ${url}`);
  return reply;
}
async function airport(code) {
  try {
    const list = await (await response(`${site}/api/icao/${code}/docs`)).json();
    if (!Array.isArray(list.docs)) throw new Error('Invalid document list');
    for (const doc of list.docs) {
      if (doc.type?.toUpperCase() !== 'PDF') continue;
      const source = new URL(doc.url, site);
      if (source.origin !== site || !source.pathname.startsWith('/uploads/'))
        throw new Error(`Unexpected document host/path: ${source.href}`);
      const reply = await response(source.href);
      if (Number(reply.headers.get('content-length')) > 40 * 1024 * 1024) throw new Error('PDF exceeds 40 MB');
      const data = Buffer.from(await reply.arrayBuffer());
      if (data.length > 40 * 1024 * 1024 || !data.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new Error(`Not a supported PDF: ${source.href}`);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const file = `${code}-${sha256.slice(0, 20)}.pdf`;
      await writeFile(new URL(file, folder), data);
      manifest[source.href] = { file, updated: doc.updated || '', name: doc.filename, airport: code,
        sha256, checkedAt: new Date().toISOString() };
      saved++;
      console.log(`${code}: cached ${doc.filename} (${data.length} bytes)`);
    }
  } catch (err) { failures++; console.error(`${code}: ${err.message}`); }
}
// Limit requests to the WorldFlight server; keep existing copies on failure.
for (let offset = 0; offset < codes.length; offset += 4)
  await Promise.all(codes.slice(offset, offset + 4).map(airport));
const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(manifestUrl, JSON.stringify(ordered, null, 2) + '\n');
console.log(`${saved} PDFs refreshed; ${failures} airports failed. Manifest: ${fileURLToPath(manifestUrl)}`);
if (failures) process.exitCode = 1;

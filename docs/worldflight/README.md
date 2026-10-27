These are unmodified published WorldFlight airport briefing PDFs, served from
the app's own domain because the planning server does not provide CORS headers
for its uploads. The manifest records the original URL, author-provided title,
published revision, SHA-256 and last refresh time. Documents remain the work of
their respective controlling teams; WorldFlight is the source of truth.

Refresh with `node tools/cache_worldflight_docs.mjs`, or supply ICAO codes.
Commit the resulting manifest and PDFs when publishing an app update. New file
contents receive new filenames so browser caches cannot serve an old revision.
The viewer uses a local copy only when its revision matches the document list.

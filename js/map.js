// Drawing the aeroplane on a map, as an SVG the page can print straight out.
// Nothing here reads app data or touches the page, so the shapes can be worked
// out (and checked) on their own.
//
// The projection is equidistant cylindrical: longitude across, latitude down,
// with longitude squeezed by the cosine of the middle latitude so a zoomed-in
// map is not stretched sideways. Everything is then fitted into a box 1000
// units wide, so line widths and markers are the same size whatever is shown.
//
// Coastlines come from js/data/world.json: Natural Earth 1:110m land, rounded
// to two decimal places. Public domain.

const RAD = Math.PI / 180;

let land = null;
let landLoading = null;

export function loadWorld() {
  landLoading ??= fetch('js/data/world.json')
    .then((r) => r.json())
    .then((d) => (land = d))
    .catch(() => (landLoading = null));
  return landLoading;
}

export const worldReady = () => !!land;

// Points along the great circle from a to b: the path an aeroplane really
// flies, which on this projection is a curve rather than a straight line.
export function greatCircle(a, b, steps = 48) {
  const [lon1, lat1] = [a.lon * RAD, a.lat * RAD];
  const [lon2, lat2] = [b.lon * RAD, b.lat * RAD];
  const d =
    2 *
    Math.asin(
      Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2),
    );
  // The two airports are in the same place, or as near as makes no difference.
  if (!d || !isFinite(d)) return [[a.lon, a.lat]];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD]);
  }
  return out;
}

// A line of longitudes that steps across the date line jumps 360 degrees on a
// flat map. Shifting each point to stay near the one before keeps it in one
// piece, even if that means longitudes beyond 180.
function unwrap(points) {
  const out = [];
  let shift = 0;
  let prev = null;
  for (const [lon, lat] of points) {
    if (prev != null) {
      if (lon + shift - prev > 180) shift -= 360;
      else if (lon + shift - prev < -180) shift += 360;
    }
    prev = lon + shift;
    out.push([prev, lat]);
  }
  return out;
}

// Fits everything inside a box 1000 units wide, keeping the shapes true.
function fitting(lines, width, height, pad) {
  const all = lines.flat();
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of all) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const midLat = (minLat + maxLat) / 2;
  // Squeeze longitude so the map is not stretched sideways away from the equator.
  const k = Math.max(0.15, Math.cos(midLat * RAD));
  const x = (lon) => lon * k;
  const y = (lat) => -lat;
  // A single point, or a very short leg, still needs something to look at.
  const spanX = Math.max(x(maxLon) - x(minLon), 2);
  const spanY = Math.max(y(minLat) - y(maxLat), 2);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offX = (width - (x(maxLon) + x(minLon)) * scale) / 2;
  const offY = (height - (y(minLat) + y(maxLat)) * scale) / 2;
  return {
    scale,
    at: (lon, lat) => [x(lon) * scale + offX, y(lat) * scale + offY],
    // Which copies of the world (every 360 degrees) the view can see.
    shifts: (() => {
      const out = [];
      for (let s = -720; s <= 720; s += 360) {
        if (x(maxLon + s) * scale + offX > -10 && x(minLon + s) * scale + offX < width + 10) out.push(-s);
      }
      return out.length ? out : [0];
    })(),
  };
}

const path = (pts, fit, shift) => {
  let d = '';
  for (const [lon, lat] of pts) {
    const [px, py] = fit.at(lon + shift, lat);
    d += `${d ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
};

// Coastlines, drawn once for each copy of the world the view can see, and only
// for the rings that actually show.
function landPaths(fit, width, height) {
  if (!land) return '';
  const out = [];
  for (const shift of fit.shifts) {
    for (const ring of land) {
      let d = '';
      let on = false;
      for (let i = 0; i < ring.length; i += 2) {
        const [px, py] = fit.at(ring[i] + shift, ring[i + 1]);
        if (px > -60 && px < width + 60 && py > -60 && py < height + 60) on = true;
        d += `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
      }
      if (on) out.push(`${d}Z`);
    }
  }
  return `<path class="map-land" d="${out.join('')}"/>`;
}

const PLANE =
  'M0 -13 L3.2 -3 L13 3.5 L13 6.5 L3.2 3.6 L2.2 10 L6 13 L6 15 L0 13.3 L-6 15 L-6 13 L-2.2 10 L-3.2 3.6 L-13 6.5 L-13 3.5 L-3.2 -3 Z';

// legs:  [{ from: {lon,lat}, to: {lon,lat}, done, active }]
// marks: [{ lon, lat, label, kind }]   airports worth naming
// plane: { lon, lat, hdg } or null
export function mapSvg({ legs = [], marks = [], plane = null, width = 1000, height = 500, pad = 54, title = '' }) {
  const paths = legs.map((leg) => ({ leg, pts: unwrap(greatCircle(leg.from, leg.to)) }));
  // Each leg is unwrapped on its own, then the whole lot is lined up so the
  // route reads as one continuous flight around the world.
  let run = 0;
  const lines = [];
  paths.forEach((p, i) => {
    if (i > 0) {
      const prevEnd = lines[i - 1][lines[i - 1].length - 1][0];
      const start = p.pts[0][0] + run;
      if (start - prevEnd > 180) run -= 360;
      else if (start - prevEnd < -180) run += 360;
    }
    lines.push(p.pts.map(([lon, lat]) => [lon + run, lat]));
  });

  // The aeroplane sits on the leg it is flying, so it lands on the drawn line
  // rather than a copy of it 360 degrees away.
  let planeAt = null;
  if (plane) {
    const flying = legs.findIndex((l) => l.active);
    const near = flying >= 0 ? lines[flying] : lines[lines.length - 1];
    let shift = 0;
    if (near?.length) {
      const mid = near[Math.floor(near.length / 2)][0];
      shift = Math.round((mid - plane.lon) / 360) * 360;
    }
    planeAt = [plane.lon + shift, plane.lat];
    lines.push([planeAt]);
  }
  // A route that goes right around the world passes the same longitude twice,
  // so each marked airport is put on the copy of the world nearest the part of
  // the route it actually belongs to.
  const drawn = lines.flat();
  for (const m of marks) {
    let best = m.lon;
    let bestGap = Infinity;
    for (let s = -720; s <= 720; s += 360) {
      for (const [lon, lat] of drawn) {
        const gap = Math.abs(lon - (m.lon + s)) + Math.abs(lat - m.lat);
        if (gap < bestGap) {
          bestGap = gap;
          best = m.lon + s;
        }
      }
    }
    lines.push([[best, m.lat]]);
  }
  if (!lines.length) return '';

  const fit = fitting(lines, width, height, pad);
  const legPaths = paths
    .map((p, i) => {
      const cls = `map-leg${p.leg.done ? ' done' : ''}${p.leg.active ? ' active' : ''}`;
      return `<path class="${cls}" d="${path(lines[i], fit, 0)}"/>`;
    })
    .join('');

  const dots = marks
    .map((m, i) => {
      const idx = lines.length - marks.length + i;
      const [px, py] = fit.at(lines[idx][0][0], lines[idx][0][1]);
      const flip = px > width - 90;
      return `<g class="map-mark ${m.kind || ''}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5.5"/>${
        m.label
          ? `<text x="${(px + (flip ? -11 : 11)).toFixed(1)}" y="${(py + 5).toFixed(1)}" text-anchor="${
              flip ? 'end' : 'start'
            }">${m.label}</text>`
          : ''
      }</g>`;
    })
    .join('');

  const planeMark = planeAt
    ? (() => {
        const [px, py] = fit.at(planeAt[0], planeAt[1]);
        return `<g class="map-plane" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${Math.round(
          plane.hdg ?? 0,
        )}) scale(0.95)"><path d="${PLANE}"/></g>`;
      })()
    : '';

  return `
    <svg class="map" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title || 'Route map'}" preserveAspectRatio="xMidYMid meet">
      <rect class="map-sea" x="0" y="0" width="${width}" height="${height}"/>
      ${landPaths(fit, width, height)}
      ${legPaths}
      ${dots}
      ${planeMark}
    </svg>`;
}

# Simulator Status API

This is the contract between the simulator PC and the QFA100 Ops Dashboard. The simulator side publishes one small JSON document describing the flight right now; while visible on a tracking page (or any page for an EFB account), the Dashboard reads it every 2 seconds and shows the position, progress and ETA.

The QFA100 bridge publishes this document through `sim` events to Supabase. Run (or rerun) `supabase/vpilot.sql` to store it in the singleton `sim_status` table. Signed-in flight deck devices, including iPads, read it automatically; no status URL is needed on those devices. A `sim-gone` event clears the stored report.

## The endpoint

```
GET <your address>      e.g. https://example.com/qfa100/status
```

- Returns `200` with a JSON body (`Content-Type: application/json`).
- Must be served over **HTTPS** and must send the header `Access-Control-Allow-Origin: *` (or the app's own address), otherwise browsers will refuse to read it.
- No login. If you want to keep it private, put a hard-to-guess token in the address itself.
- There is no setting for the address in the app, because only the computer at the simulator wants one. On that machine, open the browser console and run `qfa100.setStatusUrl('https://example.com/qfa100/status')`, or `qfa100.setStatusUrl('')` to go back to VATSIM.

## The response

Only `updatedAt` and `position.latitude` / `position.longitude` are required. Leave out anything you cannot supply and the Dashboard estimates it or hides it. Unknown fields are ignored.

When departure or arrival is missing, the Dashboard checks the callsign's VATSIM flight plan (including prefiles), then the current scheduled sector. Position and aircraft readings still come from the simulator.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | number | no | Contract version. Currently `1`. |
| `updatedAt` | string | **yes** | When this snapshot was taken, ISO 8601 in UTC, e.g. `2026-11-01T01:12:30Z`. |
| `callsign` | string | no | Callsign in use, e.g. `QFA100`. |
| `crew.pilotFlying` | string | no | Name of whoever is flying, shown as "Flown by". |
| `sector.flight` | string | no | WorldFlight sector number, e.g. `WF2601`. |
| `sector.departure` | string | no | Departure airport, 4-letter ICAO. Defaults to the scheduled sector. |
| `sector.arrival` | string | no | Arrival airport, 4-letter ICAO. Defaults to the scheduled sector. |
| `sector.alternate` | string | no | Alternate airport, 4-letter ICAO. |
| `phase` | string | no | One of the flight phases below. Worked out from speed and climb rate if missing. |
| `position.latitude` | number | **yes** | Degrees, north positive. |
| `position.longitude` | number | **yes** | Degrees, east positive. |
| `position.altitudeFt` | number | no | Altitude in feet. |
| `position.headingDeg` | number | no | Heading in degrees, 0 to 360. |
| `position.groundSpeedKt` | number | no | Ground speed in knots. |
| `position.indicatedAirspeedKt` | number | no | Indicated airspeed in knots. |
| `position.mach` | number | no | Mach number, e.g. `0.78`. |
| `position.verticalSpeedFpm` | number | no | Feet per minute, climb positive. |
| `position.onGround` | boolean | no | `true` when the wheels are on the ground. |
| `progress.distanceFlownNm` | number | no | Nautical miles flown so far on this sector. |
| `progress.distanceRemainingNm` | number | no | Nautical miles to go along the route. Straight-line distance is used if missing. |
| `progress.eta` | string | no | Estimated arrival, ISO 8601 UTC (ideally the FMC's). Estimated from ground speed if missing. |
| `fuel.onBoardKg` | number | no | Fuel on board in kilograms. |
| `blocks.out` | string | no | Off blocks, ISO 8601 UTC: when the aircraft first moved. Null until it has. |
| `blocks.off` | string | no | Airborne: when it left the ground. |
| `blocks.on` | string | no | Landed: when it was next on the ground. |
| `blocks.touchdownFpm` | number | no | Rate of descent at touchdown, feet per minute down. The simulator's own recorded touchdown figure where it has one, else the last vertical speed read before the wheels were on. Absent until it has landed. |
| `blocks.fuelOutKg` | number | no | Fuel on board in kilograms when it went off blocks. Absent until it has. |
| `blocks.fuelInKg` | number | no | Fuel on board in kilograms when it came on blocks, so what it burnt is the difference. |
| `blocks.in` | string | no | On blocks: when it stopped, reported once it is plainly parked rather than held short - engines shut down, or the park brake set and five minutes without moving. The time given is when it stopped, not when that was established. |

### Flight phases

`PREFLIGHT`, `TAXI_OUT`, `TAKEOFF`, `CLIMB`, `CRUISE`, `DESCENT`, `APPROACH`, `LANDING`, `TAXI_IN`, `ARRIVED`

### Example

See [`api/status.example.json`](../api/status.example.json).

```json
{
  "version": 1,
  "updatedAt": "2026-11-01T01:12:30Z",
  "callsign": "QFA100",
  "crew": { "pilotFlying": "Corey" },
  "sector": { "flight": "WF2601", "departure": "YSSY", "arrival": "WAAA", "alternate": "WADD" },
  "phase": "CRUISE",
  "position": {
    "latitude": -14.8512,
    "longitude": 131.2904,
    "altitudeFt": 36000,
    "headingDeg": 302,
    "groundSpeedKt": 452,
    "indicatedAirspeedKt": 272,
    "mach": 0.78,
    "verticalSpeedFpm": 0,
    "onGround": false
  },
  "progress": { "distanceFlownNm": 1840, "distanceRemainingNm": 1065, "eta": "2026-11-01T03:34:00Z" },
  "fuel": { "onBoardKg": 9450 },
  "blocks": { "out": "2026-11-01T00:12:00Z", "off": "2026-11-01T00:26:00Z", "on": null, "in": null }
}
```

## How the Dashboard treats it

- **Live:** `updatedAt` is less than 2 minutes old. The card shows `SIMULATOR LIVE`.
- **Source order:** the shared Supabase report, then the device's configured status URL, then VATSIM. An absent, invalid, stale or unavailable source falls through to the next.
- **Stale:** `updatedAt` is more than 2 minutes old (or more than 2 minutes in the future, which means a clock is wrong). If neither simulator source nor VATSIM is live, the Dashboard shows the newest valid simulator report marked `POSITION STALE`.
- **Unreachable or invalid:** the Dashboard falls back to VATSIM and shows what went wrong.

The publisher should therefore refresh the document at least every 30 seconds while the simulator is running, and always set `updatedAt` to the time the data was read from the simulator, not the time of the request.

# Public team directory

Run `supabase/team.sql` after `supabase/schema.sql` to enable **Admin → Team**.
Admins can add, edit and delete public members, upload photos, and drag members
to reorder them. The arrow buttons provide keyboard and touch reordering.
Public roles are free text and have no connection to account permissions.

The public website can fetch `GET /rest/v1/team_members?select=*&order=position.asc,id.asc`
on the configured Supabase project with its public anon/publishable API key in
the `apikey` header. No user sign-in is required. Never use a service role key
in a public website. Each row contains `id`, `name`, `role`, `description`,
`photo_url` (a public image URL), and `position` (zero-based display order).
Treat names, roles and descriptions as plain text when rendering them.

Photos accept JPEG, PNG and WebP up to 5 MB in the public `team-photos` bucket.
Replacing or deleting a member leaves previous photos in Storage so existing
public links keep working; unused photos can be removed manually in Supabase.
Only admins can write directory records or upload photos. Reordering is saved
atomically through `reorder_team_members(member_ids uuid[])`.

## GSX

Apply supabase/gsx.sql after vpilot.sql. The bridge connects to Couatl's Remote API on ws://127.0.0.1:8744/ (enable Remote control server in GSX Settings).
It publishes gsx-state every two seconds with connected, trouble and a flat state model. gsx_status retains the latest snapshot; treat it as stale after 15 seconds.
The GSX EFB page always shows illustrated shortcuts for boarding, deboarding, catering, fuel and pushback. A shortcut opens the live menu and selects its matching enabled service using the current menu token. If GSX does not offer that service, the page shows the available choices instead. Operator and pushback follow-up choices remain manual. Raw service and SimBrief payloads are not displayed. More GSX options opens the full menu; Reload SimBrief remains available.
Commands use vpilot_command: gsx-menu-open, gsx-menu-close, gsx-menu-pick {index, menuToken}, gsx-simbrief. Menu indices are zero based; menuToken is an opaque fingerprint of the rendered menu.
The bridge rejects changed menus and disabled entries and waits for the GSX result before reporting success. Timeouts have an uncertain outcome; check GSX before retrying.
Requires a desktop Couatl Remote API server; the CommBus-only WASM transport is not supported by this Windows bridge. Text prompts must currently be completed in the simulator.

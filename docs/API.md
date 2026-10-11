# Simulator Status API

This is the contract between the simulator PC and the QFA100 Ops Dashboard. The simulator side publishes one small JSON document describing the flight right now; the Dashboard reads it every 15 seconds and shows the position, progress and ETA.

Nothing publishes this yet. This document defines what a publisher has to produce. Until one exists, leave the address blank in Settings and the Dashboard uses VATSIM.

## The endpoint

```
GET <your address>      e.g. https://example.com/qfa100/status
```

- Returns `200` with a JSON body (`Content-Type: application/json`).
- Must be served over **HTTPS** and must send the header `Access-Control-Allow-Origin: *` (or the app's own address), otherwise browsers will refuse to read it.
- No login. If you want to keep it private, put a hard-to-guess token in the address itself.
- The address is entered in the app under **Settings → Simulator status API address**.

## The response

Only `updatedAt` and `position.latitude` / `position.longitude` are required. Leave out anything you cannot supply and the Dashboard estimates it or hides it. Unknown fields are ignored.

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
  "fuel": { "onBoardKg": 9450 }
}
```

## How the Dashboard treats it

- **Live:** `updatedAt` is less than 2 minutes old. The card shows `SIMULATOR LIVE`.
- **Stale:** `updatedAt` is more than 2 minutes old (or more than 2 minutes in the future, which means a clock is wrong). The Dashboard tries VATSIM instead; if the aircraft is not there either, it shows the simulator's last position marked `POSITION STALE`.
- **Unreachable or invalid:** the Dashboard falls back to VATSIM and shows what went wrong.

The publisher should therefore refresh the document at least every 30 seconds while the simulator is running, and always set `updatedAt` to the time the data was read from the simulator, not the time of the request.

# QFA100 Ops

A WorldFlight operations app for a team flying one Boeing 737 on VATSIM. It runs in any browser and installs to the home screen on iPhone, iPad and Android like a normal app.

## What it does

- **Login** – everyone signs in with their own account. The first page is the login page.
- **Dashboard** – shows where the aircraft is, its altitude, ground speed, distance to go and estimated arrival, read from the simulator's status API or from VATSIM. Shows your next rostered sector with your duty, report time and a countdown, and warns when a late arrival will push back the following departure.
- **737 Checklists** – tap-through normal checklists from Preflight to Secure, with a "CHECKLIST COMPLETE" footer and a Next button. Works with no connection and keeps the screen awake.
- **Schedule** – the official WorldFlight 2026 schedule, with departure windows (UTC), block times and validated routes. Admins can add, edit or delete sectors.
- **Roster** – who flies each sector, linked to their account, with a duty (Captain, First Officer, Relief Pilot, Observer) and a report time. Everyone sees their own roster and the full roster; admins build it.
- **Tech Log** – report defects, defer them with a simulated MEL category and restriction, or mark them rectified. Defects stay with the aircraft between sectors and show as a banner on the Dashboard.
- **Airport Briefings** – runways, elevation, live METAR, your team's own notes, and links to Navigraph Charts and ChartFox for every airport on the schedule (or any ICAO code).
- **SimBrief** – opens SimBrief with the next sector filled in, then imports your latest OFP (route, fuel, weights, times).

For flight simulation use only.

## Put it online (free, about two minutes)

The app is plain files with nothing to install or build, so GitHub can host it directly.

1. Push this folder to GitHub.
2. On GitHub, open the repository, then **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch and **/ (root)**, and press **Save**.
4. After a minute the page shows your address, something like `https://<your-username>.github.io/QFA100-DASHBOARD/`.

## Set up accounts (free, about ten minutes)

Accounts, the schedule and the roster live in a Supabase database. Until this is done the login page says "Accounts are not connected yet" and the app only works in a single-device preview with no roster.

1. Go to [supabase.com](https://supabase.com), create a free account, then **New project**. Pick a region near the team (for example Sydney) and wait for it to finish setting up.
2. Open **SQL Editor**, paste in the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. This creates the accounts, sectors and roster tables and their permissions.
3. In a new query, paste in [`supabase/schedule.sql`](supabase/schedule.sql) and press **Run**. This loads the 43 WorldFlight sectors.
4. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into [`js/config.js`](js/config.js). (The anon key is meant to be public. Never use the `service_role` key.)
5. Open **Authentication → URL Configuration** and set **Site URL** to your app's address from the section above, so confirmation emails link back to the app.
6. Push the change to GitHub.
7. Open the app and **create your own account first**. The first account becomes the admin.

Then send the link to the team. Each person presses **Create account**; by default Supabase emails them a confirmation link before they can sign in. Once they have an account you can roster them.

Worth doing once everyone has joined: **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**, so nobody else with the link can create an account and read the roster.

### Who can do what

| | Pilot | Admin |
|---|---|---|
| See the schedule, the full roster and their own roster | yes | yes |
| Change their own name and VATSIM CID | yes | yes |
| Add, edit and delete sectors | | yes |
| Roster people, set duties and report times | | yes |
| Make other people admins (Settings → Team accounts) | | yes |

These rules are enforced by the database, not just by hiding buttons. A forgotten password is reset from **Authentication → Users** in Supabase.

### If the WorldFlight schedule changes

Re-run `tools/build_schedule.py` (instructions at the top of that file), then run the new `supabase/schedule.sql` in the SQL Editor. It updates times and routes and keeps the roster.

## Notifications

Not built yet. The roster stores what a notification needs: who is on each sector, their duty and their report time. Sending one to a phone that has the app closed needs two more pieces: each device registering for push notifications, and a scheduled job in Supabase that checks for upcoming report times and sends them. On iPhone this only works once the app has been added to the home screen.

## Install it on a phone or tablet

- **iPhone / iPad:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap **⋮**, then **Install app** (or **Add to Home screen**).

## Device settings

Open **Settings** (top-right icon) to set, on each device:

- **VATSIM callsign to track** (starts as `QFA100`).
- **SimBrief username or Pilot ID**, if you want to import flight plans.
- **Simulator status API address**, once something on the simulator PC is publishing it (see below). Leave blank to use VATSIM.

## Simulator status API

The Dashboard can read the aircraft's position, phase, ETA and fuel straight from the simulator instead of VATSIM. The format the simulator side has to publish is defined in [docs/API.md](docs/API.md), with an example in `api/status.example.json`. Nothing publishes it yet; that connector is still to be built.

## Tech log and airport notes

These are still saved on each person's own device, not in the database. To share them, use **Settings → Export**, send the file to the team, and they use **Import**. Moving them into the database is the natural next step.

## Changing things

| To change | Edit |
|---|---|
| Checklist items and wording | `js/data/checklists.js` |
| Colours and layout | `css/app.css` |
| Default callsign, aircraft type, report time before departure | `js/store.js` |
| Tech log system list | `js/views/techlog.js` |
| Database connection | `js/config.js` |

Edits to existing files show up the next time the app is opened online. If you add or rename a file, also add it to the list in `sw.js` and change the `CACHE` name there (for example to `qfa100-ops-v5`) so it is available offline.

## Try it on your own computer

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` by double-clicking will not work; browsers require a web address for apps like this.)

## Where the data comes from

- Accounts, schedule and roster: your Supabase project, refreshed every two minutes and whenever the app is reopened. The last copy is kept on the device for use offline.
- Aircraft position: the simulator status API if configured, otherwise the public [VATSIM data feed](https://data.vatsim.net/v3/vatsim-data.json), refreshed every minute while the Dashboard is open. Without a simulator ETA, the ETA is a straight-line estimate from ground speed.
- Weather: VATSIM's METAR service.
- Flight plans: SimBrief's "latest OFP" service for your username.
- Schedule: the official [WorldFlight planning site](https://planning.worldflight.center/schedule), as published on 12 October 2026.
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain). Rebuild with `tools/build_airports.py`.
- Charts are not embedded; Navigraph's licence does not allow that, so the app links out to the official sites.

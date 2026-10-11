# QFA100 Ops

A WorldFlight operations app for a team flying one Boeing 737 on VATSIM. It runs in any browser and installs to the home screen on iPhone, iPad and Android like a normal app.

## What it does

- **Flight Deck** – finds the team aircraft on VATSIM by callsign and shows where it is, its altitude, ground speed, distance to go and an estimated arrival time. Shows your next sector with a countdown, and warns when a late arrival will push back the following departure.
- **737 Checklists** – tap-through normal checklists from Preflight to Secure, with a "CHECKLIST COMPLETE" footer and a Next button. Works with no connection and keeps the screen awake.
- **Schedule** – every sector with times (UTC) and crew. Add, edit and delete sectors in the app.
- **Tech Log** – report defects, defer them with a simulated MEL category and restriction, or mark them rectified. Defects stay with the aircraft between sectors and show as a banner on the Flight Deck.
- **Airport Briefings** – runways, elevation, live METAR, your team's own notes, and links to Navigraph Charts and ChartFox for every airport on the schedule (or any ICAO code).
- **SimBrief** – opens SimBrief with the next sector filled in, then imports your latest OFP (route, fuel, weights, times).

For flight simulation use only.

## Put it online (free, about two minutes)

The app is plain files with nothing to install or build, so GitHub can host it directly.

1. Push this folder to GitHub (the repository is already set up for it).
2. On GitHub, open the repository, then **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick **main** and **/ (root)**, and press **Save**.
4. After a minute the page shows your address, something like `https://<your-username>.github.io/QFA100-DASHBOARD/`. Send that link to the team.

## Install it on a phone or tablet

- **iPhone / iPad:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap **⋮**, then **Install app** (or **Add to Home screen**).

## First-time setup

Open **Settings** (top-right icon) and enter:

- **Your name**, spelled the same as on the schedule, so the Flight Deck shows your sectors.
- **VATSIM callsign to track** (starts as `QFA100`).
- **SimBrief username or Pilot ID**, if you want to import flight plans.

Then open **Schedule**, press **Clear** on the sample schedule, and add your team's real sectors.

## Sharing data with the team

The schedule, tech log and airport notes are saved on each person's own device. To give everyone the same data, one person enters it and uses **Settings → Export team data**, then sends the file to the team, who use **Import team data**. Importing replaces what is on that device.

Automatic syncing between devices, and real logins, need an online database (for example Supabase). That is the natural next step and the app is laid out so it can be added.

## Changing things

| To change | Edit |
|---|---|
| Checklist items and wording | `js/data/checklists.js` |
| Colours and layout | `css/app.css` |
| Default callsign, aircraft type, sample schedule | `js/store.js` |
| Tech log system list | `js/views/techlog.js` |

Edits to existing files show up the next time the app is opened online. If you add or rename a file, also add it to the list in `sw.js` and change the `CACHE` name there (for example to `qfa100-ops-v2`) so it is available offline.

## Try it on your own computer

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` by double-clicking will not work; browsers require a web address for apps like this.)

## Where the data comes from

- Aircraft position: the public [VATSIM data feed](https://data.vatsim.net/v3/vatsim-data.json), refreshed every minute while the Flight Deck is open. The ETA is a straight-line estimate from ground speed, not the FMC's.
- Weather: VATSIM's METAR service.
- Flight plans: SimBrief's "latest OFP" service for your username.
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain). Rebuild with `tools/build_airports.py`.
- Charts are not embedded; Navigraph's licence does not allow that, so the app links out to the official sites.

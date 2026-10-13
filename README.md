# QFA100 Ops

A WorldFlight operations app for a team flying one Boeing 737 on VATSIM. It runs in any browser and installs to the home screen on iPhone, iPad and Android like a normal app.

## What it does

- **Login** – everyone signs in with their own account. The first page is the login page.
- **Dashboard** – shows where the aircraft is, its altitude, ground speed, distance to go and estimated arrival, read from the simulator's status API or from VATSIM. Shows your next rostered sector with your duty, report time and a countdown, and warns when a late arrival will push back the following departure.
- **737 Checklists** – tap-through normal checklists from Preflight to Secure, with a "CHECKLIST COMPLETE" footer and a Next button. Works with no connection and keeps the screen awake.
- **Schedule** – the official WorldFlight 2026 schedule. Each sector shows when its departure window opens (UTC), the window, block time and validated route. Admins and dispatchers can add, edit or delete sectors.
- **Roster** – who flies each sector, linked to their account, with a duty (Captain, First Officer, Relief Pilot, Observer) and a report time. Everyone sees their own roster and the full roster, with short-crewed sectors flagged. The cockpit tablets sign in to their own accounts and show the whole team's roster instead.
- **Admin** (shield icon, top right) – where the roster is built: pick a Captain and First Officer for each sector from a dropdown and it saves straight away. Admins also set each person's role here.
- **Tech Log** – report defects, check them against the built-in MEL, defer them with a restriction, or mark them rectified. The log is shared by the whole team, stays with the aircraft between sectors and shows as a banner on the Dashboard.
- **MEL** – the 737 Minimum Equipment List as drop-downs (system → item → option) inside the Tech Log: it shows whether the aircraft can go with something inoperative, the conditions, and how long the fix can wait.
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
4. In another query, paste in [`supabase/worldflight.sql`](supabase/worldflight.sql) and press **Run**. This sets up the six-hourly check of the official schedule (see below). It is optional; everything else works without it.
5. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into [`js/config.js`](js/config.js). (The anon key is meant to be public. Never use the `service_role` key.)
6. Open **Authentication → URL Configuration** and set **Site URL** to your app's address from the section above, so confirmation emails link back to the app.
7. Push the change to GitHub.
8. Open the app and **create your own account first**. The first account becomes the admin.

Then send the link to the team. Each person presses **Create account**; by default Supabase emails them a confirmation link before they can sign in. A new account then waits on an "Awaiting approval" page and can see nothing until an admin approves it in **Admin → People and roles**. Admins get a banner on the Dashboard when someone is waiting.

Optional once everyone has joined: **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**, so strangers with the link cannot create accounts at all.

### Roles

| | Observer | Pilot | EFB tablet | Dispatcher | Admin |
|---|---|---|---|---|---|
| See the schedule, the full roster and their own roster | yes | yes | full roster only | yes | yes |
| Change their own name and VATSIM CID | yes | yes | yes | yes | yes |
| Write in the tech log | | | yes | yes | yes |
| Write sector briefings and the handover | | yes | yes | yes | yes |
| Be rostered as a pilot | | yes | | yes | yes |
| Add, edit and delete sectors | | | | yes | yes |
| Build the roster, set duties and report times | | | | yes | yes |
| Change other people's roles | | | | | yes |

New accounts start as **Awaiting approval** and see nothing; approving one makes it a Pilot. An admin changes roles, or sets someone back to Awaiting approval to remove their access, in **Admin → People and roles**. These rules are enforced by the database, not just by hiding buttons. A forgotten password is reset from **Authentication → Users** in Supabase.

### EFB tablet accounts

The tablets that live in the cockpit sign in to their own shared accounts, so they show the aeroplane rather than one person. **Both accounts are built in**: `supabase/schema.sql` creates them, there is no email address to make up and nothing to approve. On the login page they sign in by name:

| Tablet | Sign in as | Password |
|---|---|---|
| Captain's side | `captain` | the flight deck password |
| First officer's side | `first_officer` | the same |

The password is set in `supabase/schema.sql` (it starts as `flightdeck`, on a line marked for you to change before you run it). To change it afterwards, edit `supabase/efb-password.sql` and run that in the SQL Editor. Capitals and spaces do not matter when signing in, so "First Officer" works as well as `first_officer`.

A tablet account:

- shows **the full roster** and the crew on each sector, never a personal roster or availability;
- shows the crew flying now and the crew taking the next sector on its Dashboard, with their duties and report times;
- **keeps the tech log**: it is the only account besides ops staff that can add, change or rectify a defect, and the **Reported by** field is a drop-down of the team, so the tablet records whoever actually found it;
- cannot be rostered onto a sector, and is not offered as crew anywhere;
- says **FLIGHT DECK · CAPTAIN EFB** (or FIRST OFFICER EFB) at the top, so nobody mistakes it for their own device.

Pilots still read the whole tech log and the MEL on their own phones; they just cannot write in it. Anything they find goes to the flight deck, which is where the log is kept.

### Building the roster with Auto roster

1. **Draft.** The roster starts as a draft. Pilots cannot see it; their Roster tab only offers **Set my availability**.
2. **Availability.** Everyone counts as available for every sector unless they say otherwise, so a pilot only marks the sectors they would like (Prefer) or cannot fly (Can't). Turn that off in **Admin → Rules** if you would rather nobody is rostered until they answer. Times are shown in Zulu and sim local (Sydney) time, and back-of-clock sectors are flagged. Admins and dispatchers can fill it in for someone from **Admin → Auto roster**.
3. **Roster by hand.** **Admin → Roster** lists every upcoming sector with its crew and what it still needs. Open one to get its own page: the times, the departure window, the seats, and **Who can fly this** — every pilot on the team with what they said about the sector, what they are already flying ("4 sectors · 2 CA, 1 FO"), their hours and back-of-clock count, and **every duty rule that rostering them would break**, written out in full. Press a seat button (CA, FO, RP) to roster them, or press it again to take them off. Nothing is blocked: if you need someone on a flight, put them there and the rule check will keep reminding you. Do the whole roster this way if you like, or only pin the people who must fly a particular sector and let Auto roster do the rest.
4. **Auto roster.** **Admin → Auto roster → Auto roster the gaps** fills the empty seats. It never moves anyone already rostered, never uses someone who marked Can't, and stays inside the duty rules. Seats it cannot fill are listed. **Clear auto-rostered** removes only what it placed, so you can adjust and run it again.
5. **Check the share.** **Admin → Balance** shows every pilot's sectors broken down by seat (CA, FO, relief pilot), their block hours and their back-of-clock sectors, with a chip saying whether the totals are even or how far apart they are.
6. **Check and publish.** The rule check lists anyone whose roster breaks a rule (including people you pinned). **Publish roster** makes it visible to everyone.

The duty rules are edited in **Admin → Rules** and apply to the whole team: minimum rest, sectors per duty (one, so everyone rests between sectors), longest duty, sectors per person, the length over which a sector also carries a relief pilot (six hours, so those sectors are rostered with three pilots instead of two; set it to 0 to turn it off), the back-of-clock window how many back-of-clock sectors each person may fly in the event (two) and how far apart they must be (one every two days, so never on consecutive nights), report times, and whether everyone counts as available unless they say otherwise (on by default, so a pilot only marks the sectors they want or cannot fly). Sectors with less than the minimum rest between them count as one duty.

Auto roster is a sensible-rules fill, not a perfect optimiser: it works through the sectors in order, evening out the number of sectors each person flies and the time they spend in each seat, favouring sectors people asked for and keeping a crew together on back-to-back sectors. Expect to adjust a few by hand.

### Test accounts

To try out the roster without waiting for real people to sign up, an admin can add stand-in team members in **Admin → People and roles → Test accounts**. They can be rostered and given roles like anyone else, they are marked TEST, and nobody can sign in as one. Everyone on the team sees them until you remove them, which also removes their roster entries.

### After updating the app

When a new version changes the database (new roles, new schedule times), run `supabase/schema.sql` and then `supabase/schedule.sql` again in the SQL Editor. Both are safe to re-run and keep your accounts and roster, and re-running the schema does not reset a tablet password you have changed.

### If the WorldFlight schedule changes

Nothing to run: the database watches for it. [`supabase/worldflight.sql`](supabase/worldflight.sql) sets up a job inside Supabase that reads <https://planning.worldflight.center/schedule> every six hours, parses the 43 sectors out of it and keeps them in a table of their own, `official_schedule`. It uses two free Supabase extensions, `http` and `pg_cron`, and the file turns both on.

Admins and dispatchers then see it in the app:

- a banner on the Dashboard — **WorldFlight schedule changed · 4 sectors differ from the official one**;
- a card at the top of **Schedule** listing exactly what moved (departure and arrival times, airports, the departure window, the route) and any new sectors;
- one button, **Update N sectors**, which writes them to the team's schedule. Roster entries, sector notes and briefings all stay where they are, and sectors you added yourself are listed but never touched.

Nothing is applied to the database on its own, so a change to the official programme can never quietly move a sector somebody is about to fly. When the two match, the Schedule page says so.

The Schedule page says when the site was last read ("Read from the WorldFlight site 36m ago"), and if a check fails it says so and why, rather than going quiet — the copy it read before that is kept and used. If WorldFlight ever rebuilds the page, the check fails loudly in that line instead of writing nonsense into the table.

Until that SQL is run, the app compares against the copy it was built with (`js/data/schedule.js`), which is rebuilt by `tools/build_schedule.py`. To read the site by hand at any time, run `select public.refresh_official_schedule();` in the SQL Editor.

## Running late

WorldFlight slips, and a late sector in Indonesia is still late over Canada two days later. The app keeps the published schedule exactly as it is and lays the real running over the top of it.

The flight deck stamps two times per sector, **Off blocks** and **On blocks**, from the Dashboard. Each button shows the Zulu time it will record, counting up with the clock, so one press records that moment and there is nothing to fill in. **Different time** under it takes a time typed in Zulu instead, and **Change** does the same to a time already stamped — useful when the button gets pressed ten minutes after the event. When VATSIM shows the aircraft stopped at the destination, the on-blocks button offers that moment rather than now. Admins and dispatchers can correct one afterwards, or enter one nobody stamped at the time, from the sector's page on the Schedule.

From those stamps the app works out, for every sector still to come:

```
estimated off = later of ( published departure , previous arrival + turnaround )
estimated on  = live ETA while airborne, otherwise estimated off + the published block time
delay         = estimated off - published departure
```

Two things follow from that. A sector cannot leave before its window opens, so **slack in the schedule absorbs the delay** instead of passing it on — the app says so rather than claiming everything for the next three days is 35 minutes late. And because each sector waits for the aeroplane plus the turnaround, a delay does carry through a tight run of sectors, which is exactly what happens in the event.

What you see:

- a banner on the Dashboard — **Running 35m behind the published schedule · WF2601 lands about 1505Z**;
- on the Schedule, the published time struck through with the real expected time under it;
- on your own sector card, your report time moved by the delay, with the published one still shown underneath, keeping whatever lead you were given when you were rostered.

Nothing is shown until somebody stamps a time or the aircraft is being tracked, and estimates are rounded to five minutes, because a guess printed to the minute reads as more certain than it is. Stamped times are shown exactly. **Minimum turnaround** and **Taxi in** are in **Admin → Rules**, so the whole team works from the same numbers.

The estimate takes the best source it has, in this order: a stamped time, the simulator API, the live VATSIM position, then the published block time. With nothing connected at all it is simply the published schedule, which is where you started.

## Notifications

The app can notify a phone even when it is closed. Four things are sent, and nothing else:

- **the roster is published** — with how many sectors you have and when the first one is;
- **your own sectors change** — added, taken off, duty or report time moved;
- **a delay moves your report time** by more than the threshold in **Admin → Rules**;
- **a reminder** a set time before you report, using the real time including the delay.

Each person turns it on in **Settings → Notifications**, on each device they want told, and chooses which of the four they want and how early under **What to tell me** — those choices follow the person, so they are the same on their phone and their iPad. The numbers in **Admin → Rules** are only the starting point for somebody who has not chosen. Nobody is sent anything until they turn it on. On iPhone and iPad it only works once the app has been added to the Home Screen and opened from there; the app says so rather than failing silently.

### Setting it up

This is the one part of the app with a piece outside Supabase's SQL editor: the sending has to be signed, which needs a small function running somewhere. Supabase runs it for free.

1. In Supabase, open **Edge Functions → Deploy a new function**, name it exactly `send-push`, and paste in the whole of [`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts). Deploy it. Its address is then `https://YOUR-PROJECT.supabase.co/functions/v1/send-push`. Supabase will not run a function at all without an `Authorization` header, so either turn **Verify JWT** off for this one (its own shared secret is the real check) or leave it on — the database sends the publishable key as well, which satisfies it.
2. Open the SQL Editor and paste in [`supabase/notifications.sql`](supabase/notifications.sql). Three lines are marked `<= fill in`: the VAPID private key (the public half is already in `js/config.js`; whoever set this up has the private half), that function address, and any long random string as a shared secret so only the database can call the function. Fill them in **in the editor, not in the file**, because this repository is public. Press Run. Those three are only written the first time, so running the file again later — for a new version of the app — keeps them and you never paste them in twice. To change one, run `update public.push_config set secret = 'the new one' where id;`.
3. Open the app, go to **Settings → Notifications** and turn it on. Press **Show me one** to check it appears.

The database builds the messages and asks the function to deliver them once a minute. A message is encrypted for the one device it is going to ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), so the push service that carries it cannot read it. A device that has uninstalled the app or turned notifications off is dropped automatically the next time something is sent to it.

If notifications stop working, run `select public.push_tick();` in the SQL editor: it returns what it did, including anything the sending function complained about.

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

## Sector briefings

The **Briefings** tab opens the briefing for the next sector (pick any other from the drop-down). It is saved in the team database, so everyone sees the same thing:

- **Flight plan (OFP)** – imported from SimBrief and saved for the whole team. An admin or dispatcher sets the team's one SimBrief username or Pilot ID on the briefing page; until then each person imports from their own account in Settings. A plan for a different sector is refused.
- **Aircraft status** – open and deferred defects from the tech log, with their restrictions.
- **Handover** – what the previous sector's crew left for this one, and a box for this crew to leave theirs.
- **Team notes**, and **WorldFlight's page and briefing notes** for the sector (paste the address and their notes).

Pilots, dispatchers and admins can write; observers read. The MEL lookup and the defect form also have a search box (try "radar" or "34-15").

## Live updates, password reset and removing accounts

- The app checks the team database every 10 seconds while it is open, so other people's changes (roster, schedule, tech log, approvals) appear without reloading. It never redraws a form you are filling in.
- **Forgot your password?** on the sign-in page emails a reset link. The link opens the app on a "Choose a new password" page. This relies on **Site URL** in Supabase (Authentication → URL Configuration) being the app's address. Supabase's built-in email service only sends a few emails an hour.
- Admins can **Reject** an account that is waiting for approval, which deletes it. To remove an existing member, set their role to "Awaiting approval" first, then reject.

## Tech log and MEL

The tech log lives in the team database, so everyone sees the same entries on every device. It is kept on the flight deck: the **EFB tablet** accounts, dispatchers and admins add and update entries, and the **Reported by** field names whoever found the defect. Everyone else reads it. Only admins and dispatchers can delete an entry. If the database was set up before the tech log was added, run `supabase/schema.sql` again (it is safe to re-run). Entries written on a device before that show a prompt on the Tech Log page to upload them.

The MEL is the team's Boeing 737-800 operator MEL (Revision 8, September 2021), stored in `js/data/mel.json` together with its (O) crew and (M) maintenance procedures, which open under each item's conditions. To rebuild it from a newer PDF (on a Mac):

```
swift tools/mel_words.swift "B737 MEL.pdf" words.tsv
python3 tools/build_mel.py words.tsv
```

Each entry keeps a history of who reported, deferred, edited and rectified it; the database writes that itself. An open defect has a quick **Mark rectified** box at the top of its page.

It is for flight simulation only. Repair categories: A as stated in the item, B 3 days, C 10 days, D 120 days.

## Airport notes

These are still saved on each person's own device, not in the database. To share them, use **Settings → Export**, send the file to the team, and they use **Import**.

## Changing things

| To change | Edit |
|---|---|
| Checklist items and wording | `js/data/checklists.js` |
| Colours and layout | `css/app.css` |
| Default callsign and aircraft type | `js/store.js` |
| Duty rules and report times | in the app: **Admin → Rules** (starting values are in `js/autoroster.js`) |
| Minimum pilots per sector (`MIN_PILOTS`) | `js/ops.js` |
| MEL items | rebuild `js/data/mel.json` with `tools/build_mel.py` |
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

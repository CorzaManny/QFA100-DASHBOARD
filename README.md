# QFA100 Ops

WorldFlight PDFs open inside the app with page navigation, 10–600% zoom,
fit-to-width/page, pinch zoom and drag to pan. The PDF.js renderer is bundled
locally in `vendor/pdfjs`; no database migration is needed. Hosts that block
cross-origin PDF reads use local copies of the official published PDFs. Refresh
these with `node tools/cache_worldflight_docs.mjs` (all schedule airports), or
append ICAO codes to refresh selected airports. Publish the generated PDFs and
manifest with the app. The viewer matches the source URL and published revision
before using a local copy; other documents can use the basic embedded viewer.
To verify PDF rendering and zoom, serve the repository over HTTP and open
`tools/test_pdf_viewer.html`; it generates a two-page PDF and reports PASS/FAIL.

A WorldFlight operations app for a team flying one Boeing 737 on VATSIM. It runs in any browser and installs to the home screen on iPhone, iPad and Android like a normal app.

## What it does

- **Login** – everyone signs in with their own account. The first page is the login page.
- **Dashboard** – a map of the sector being flown with the aeroplane on it, and shows where the aircraft is, its altitude, ground speed, distance to go and estimated arrival, read from the simulator's status API or from VATSIM. Shows your next rostered sector with your duty, report time and a countdown, and warns when a late arrival will push back the following departure. Your report time is the one you were given: a delay does not move it, it asks ops to (see **Running late**).
- **737 Checklists** – tap-through checklists in two groups: **Normal** from Preflight to Secure, and **Non-normal**, the extracted QRH. Each group lists its checklists down the side with how far through each one is, and there is a "CHECKLIST COMPLETE" footer and a Next button. Works with no connection and keeps the screen awake. An **admin** can reword the normal checklists in the app and add their own – see below.
- **Schedule** – the official WorldFlight 2026 schedule. Each sector shows when its departure window opens (UTC), the window, block time and validated route. Tapping a sector opens its briefing; admins and dispatchers can add, edit or delete sectors.
- **Roster** – who flies each sector, linked to their account, with a duty (Captain, First Officer, Relief Pilot, Observer) and a report time. Everyone sees their own roster and the full roster, with short-crewed sectors flagged. Your own sectors carry the duty length and sign-off time, each seat has its own colour, and your breaks between sectors are drawn in as well. The cockpit tablets sign in to their own accounts and show the whole team's roster instead.
- **Duty Report** – from the Roster, a printable sheet for your next duty period: the back-to-back sectors in it, when you sign on and off, each flight's times, the aeroplane and who is in every seat, and otherwise left empty to write on during the sector. It prints from the browser, so the same button saves it as a PDF.
- **Admin** (shield icon, top right) – where the roster is built: pick a Captain and First Officer for each sector from a dropdown and it saves straight away. Admins also set each person's role here.
- **Tech Log** – report defects, check them against the built-in MEL, defer them with a restriction, or mark them rectified. The log is shared by the whole team, stays with the aircraft between sectors and shows as a banner on the Dashboard.
- **MEL** – the 737 Minimum Equipment List as drop-downs (system → item → option) inside the Tech Log: it shows whether the aircraft can go with something inoperative, the conditions, and how long the fix can wait.
- **Airport Briefings** – runways, elevation, live METAR and TAF, who is controlling the airport on VATSIM with their ATIS, your team's own notes, and links to Navigraph Charts and ChartFox for every airport on the schedule (or any ICAO code).
- **SimBrief** – opens SimBrief with the next sector filled in, then imports your latest OFP (route, fuel, weights, times). The link already carries extra fuel for any holding or traffic the Briefing expects at the destination.
- **Loadsheet** – load control sends the loadsheet up the datalink and it prints on the flight deck printer, unasked for, at a random moment between 20 and 7 minutes before departure – the figures off the imported OFP, for the crew to enter. Import a new flight plan after one has printed and a revision follows, 10 to 5 minutes out, or a minute or two after the import if there is no longer room for that. It never waits on the aeroplane. The sector's briefing page says where its sheet is up to, with **Resend loadsheet** to put it back in the queue on the same terms. If the printer jammed or the simulator PC was down when it went, ops and admins can force one out on the spot from the **Ops board**. Needs [`supabase/loadsheet.sql`](supabase/loadsheet.sql) and the ACARS tables; without it nothing is sent and both buttons leave themselves out.
- **Stream** – on the flight deck tablets and for ops staff: a muted preview of the team's Twitch stream as the audience sees it, and a list of things worth talking about, half typed in by ops and half worked out from the flight itself. Chat sits in its own panel beside every page on a flight deck tablet.
- **Ops chat** – a panel beside every page, for the flight deck tablets, Operations and admins: one thread between the cockpit and whichever operations controller is on shift, with that controller's name at the top of it so the crew know who is answering and the controllers know whose turn it is. Who is on comes from a shift roster kept in **Admin → Ops Desk**, which nobody else sees, and a controller stepping in off the roster can take the desk there. That roster is drawn rather than typed: a day of hours across the top, a row per controller, and shifts dragged out and stretched to length, with a strip above it showing where nobody has the desk at all. A **Call** button beside the thread puts the two sides on a voice call inside the app: the audio goes straight between the two devices, so nothing is recorded and nothing passes through a server. It rings whoever has the desk (or every controller when nobody has it), and both tablets when ops calls them. A message from the other side dings inside the app and notifies the phone of whoever it is for: the controller on shift when the flight deck asks something (all of them when nobody is on the desk), and both tablets when ops answers. At most one notification per half minute each, however much is being said, sent within about ten seconds, and each person can switch them off in Settings.
- **Ops board** – for admins, dispatchers and operations: where the aeroplane is and how far behind the day is running, **report times a delay wants moved**, waiting for the controller to approve, retime by hand or leave alone, swaps and seat requests with the buttons to settle them, which roster changes each pilot has still to confirm, any defect grounding the aircraft, who reports next with live countdowns, which sectors are short of pilots, which still have no flight plan, and the weather at the airports coming up.
- **Logbook** – the whole route around the world on one map, how far the team has got, and who has flown what, in hours, sectors and miles.

For flight simulation use only.

## Put it online (free, about two minutes)

The app is plain files with nothing to install or build, so GitHub can host it directly.

1. Push this folder to GitHub.
2. On GitHub, open the repository, then **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch and **/ (root)**, and press **Save**.
4. After a minute the page shows your address, something like `https://<your-username>.github.io/QFA100-DASHBOARD/`.

### The team's own address

QFA100 runs at **<https://efb.qfa100.org>**. The app uses relative paths
throughout, so it works from a subfolder or from the root of a domain with no
change to the code.

To point a subdomain at GitHub Pages, add one DNS record where the domain's DNS
is managed, leaving every other record alone:

| Type | Name | Value |
|---|---|---|
| CNAME | `efb` | `corzamanny.github.io` |

Then in **Settings -> Pages**, put `efb.qfa100.org` in **Custom domain**, wait
for the DNS check to pass, and tick **Enforce HTTPS**. Saving the domain adds a
`CNAME` file to the published branch; leave it there.

Two more things follow a change of address. In Supabase, **Authentication ->
URL Configuration**, set the **Site URL** and add the new address to **Redirect
URLs**, or password-reset links come back to the old one. And because a new
address is a different site to a browser, everybody signs in again, adds the
app to their home screen again and turns notifications back on.

## Set up accounts (free, about ten minutes)

Accounts, the schedule and the roster live in a Supabase database. Until this is done the login page says "Accounts are not connected yet" and the app only works in a single-device preview with no roster.

1. Go to [supabase.com](https://supabase.com), create a free account, then **New project**. Pick a region near the team (for example Sydney) and wait for it to finish setting up.
2. Open **SQL Editor**, paste in the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. This creates the accounts, sectors and roster tables and their permissions.
3. In a new query, paste in [`supabase/schedule.sql`](supabase/schedule.sql) and press **Run**. This loads the 43 WorldFlight sectors.
4. In another query, paste in [`supabase/pickups.sql`](supabase/pickups.sql) and press **Run**. This lets pilots ask for an empty seat once the roster is published, for an admin or dispatcher to agree.
5. In another query, paste in [`supabase/accounts.sql`](supabase/accounts.sql) and press **Run**. This is how an admin makes accounts for the team, and it removes test accounts.
6. In another query, paste in [`supabase/operations-role.sql`](supabase/operations-role.sql) and press **Run**. This adds the Operations role: ops staff who run the roster but do not fly.
7. In another query, paste in [`supabase/simbrief.sql`](supabase/simbrief.sql) and press **Run**. This limits the aeroplane and SimBrief settings to admins and operations.
8. In another query, paste in [`supabase/stream.sql`](supabase/stream.sql) and press **Run**. This holds the team's Twitch channel and the talking points shown on the flight deck. It is optional.
9. In another query, paste in [`supabase/bidding.sql`](supabase/bidding.sql) and press **Run**. This lets an admin set a deadline for everyone's availability. It is optional; without it availability stays open and the roster can be published whenever you like.
10. In another query, paste in [`supabase/weather.sql`](supabase/weather.sql) and press **Run**. This lets the airport pages show TAFs. It is optional; without it they show the METAR and the VATSIM ATIS only.
11. In another query, paste in [`supabase/worldflight.sql`](supabase/worldflight.sql) and press **Run**. This sets up the six-hourly check of the official schedule (see below). It is optional; everything else works without it.
12. In another query, paste in [`supabase/ops-chat.sql`](supabase/ops-chat.sql) and press **Run**. This adds the ops desk: the controllers' shift roster and the chat thread the flight deck tablets message them on. It is optional; without it there is no ops chat panel.
13. In another query, paste in [`supabase/ops-chat-notify.sql`](supabase/ops-chat-notify.sql) and press **Run**. This notifies the controller on shift when the flight deck messages them, and the tablets when ops answers. It needs both the file above and notifications.sql, and is optional: without it the chat still dings and badges inside the app.
14. In another query, paste in [`supabase/ops-call.sql`](supabase/ops-call.sql) and press **Run**. This lets the flight deck and the ops desk call each other in the app: it says who may join the channel that carries the handshake, and sends the notification that tells somebody their app is ringing. Optional, and calling does nothing until it has been run.
15. In another query, paste in [`supabase/normal-checklists.sql`](supabase/normal-checklists.sql) and press **Run**. This lets an admin reword the normal checklists, reorder them and add their own, from the Checklists page in the app. It is optional; without it the whole team flies the checklists the app ships with and there is nothing to edit.
16. In another query, paste in [`supabase/airport-docs.sql`](supabase/airport-docs.sql) and press **Run**. This lets the briefings show the official WorldFlight pilot briefing and charts for each airport. It is optional; without it the briefings say so and show everything else.
17. In another query, paste in [`supabase/route-options.sql`](supabase/route-options.sql) and press **Run**, then run [`supabase/worldflight.sql`](supabase/worldflight.sql) again (or re-run `supabase/schedule.sql`) so the alternatives are read in. This is the handful of sectors WorldFlight publishes two ways round, with a button for an admin to choose which way the team flies. It is optional; without it the app shows the published route only.
18. In another query, paste in [`supabase/crew-confirm.sql`](supabase/crew-confirm.sql) and press **Run**. This makes every change to somebody's roster something they have to read and confirm before they can use the app, and shows ops who has. It is optional; without it the app tells them and nothing is held.
19. In another query, paste in [`supabase/report-shifts.sql`](supabase/report-shifts.sql) and press **Run**. It needs `notifications.sql` (below) to have been run first. This is how a delay asks for a report time to be moved instead of moving it: the proposals land on the Ops board for the controller on shift to decide. It is optional; without it report times only change when somebody edits the roster.
18. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into [`js/config.js`](js/config.js). (The anon key is meant to be public. Never use the `service_role` key.)
19. Open **Authentication → URL Configuration** and set **Site URL** to your app's address from the section above, so password-reset emails link back to the app. Then open **Authentication → Sign In / Providers → Email** and turn off **Confirm email**: the team does not verify addresses, because an admin approves every new account anyway.
20. Push the change to GitHub.
21. Open the app and **create your own account first**. The first account becomes the admin.

Nobody signs themselves up. An admin makes each account in **Admin → People
and roles → Add a team member**: a name, a role, and a password to pass on. The
app hands back that password and a placeholder email address, shown once, for
the admin to give the person however they like. The first time that person signs
in, the only thing they can do is put in their own email address and choose
their own password; the rest of the app opens once they have.

Nothing is ever emailed to anybody, and the placeholder address is at a domain
that can never exist, so it cannot reach a real inbox by accident.

Close the door at the server too, not just in the app: **Authentication → Sign
In / Providers → Email**, and switch off **Allow new users to sign up**.

### Roles

| | Observer | Pilot | EFB tablet | Operations | Dispatcher | Admin |
|---|---|---|---|---|---|---|
| See the schedule, the full roster and their own roster | yes | yes | full roster only | yes | yes | yes |
| Change their own name | yes | yes | yes | yes | yes | yes |
| Write in the tech log | | | yes | yes | yes | yes |
| Write sector briefings and the handover | | yes | yes | yes | yes | yes |
| Be rostered as a pilot | | yes | | | yes | yes |
| Set their own availability | | yes | | | yes | yes |
| Add, edit and delete sectors | | | | yes | yes | yes |
| Build the roster, set duties and report times | | | | yes | yes | yes |
| CTWO+ briefing, and the ACARS datalink station | | | yes | | | |
| Ops chat and calls with the flight deck | | | yes | yes | | yes |
| Send the crew a company ACARS message | | | | yes | yes | yes |
| Change the team's settings and other people's roles | | | | | | yes |

**Operations** is for people who run the event but do not fly it. They can do
everything a dispatcher can — build the roster, edit the schedule, agree swaps
and seat pickups, keep the tech log — but they are never on the roster
themselves, so the app never asks them for availability and never offers them a
seat. It needs [`supabase/operations-role.sql`](supabase/operations-role.sql).

Three pages are the **flight deck's alone**, so nobody else is given a tab for
them: the **CTWO+ Briefing**, which the crew tick through item by item with the
ticks shared between the two tablets, and the **ACARS** datalink station, which
is worked from the cockpit. The one part of ACARS that belongs to ops — a
company message to the crew — is on the **Ops Board** instead, under *Message
the flight deck*. An admin still writes the CTWO+ points, from
**Admin → Settings → CTWO+ briefing points**.

The **ops chat** panel is the thread between the cockpit tablets and whoever is
working the ops desk, so only the tablets, **Operations** and **Admin** get its
icon. A dispatcher builds the roster and the schedule but does not answer the
flight deck, so they are not in the thread and are never notified about it.

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

0. **Bidding (optional).** An admin can set a moment when availability closes, in **Admin → Settings → Bidding**. Until then everyone sees a banner counting down to it, pilots can change their availability freely, and **the roster cannot be published**. At the deadline availability is sealed and the roster is built from it. Ops staff can still change somebody's availability afterwards, because a late phone call still has to be dealt with. Leave it switched off and availability stays open with no deadline at all. It needs [`supabase/bidding.sql`](supabase/bidding.sql), and the database enforces both the seal and the publishing block.
1. **Draft.** The roster starts as a draft. Pilots cannot see it; their Roster tab only offers **Set my availability**.
2. **Availability.** Everyone counts as available for every sector unless they say otherwise, so a pilot only marks the sectors they would like (Prefer) or cannot fly (Can't). Turn that off in **Admin → Settings** if you would rather nobody is rostered until they answer. Times are shown in Zulu and sim local (Sydney) time, and back-of-clock sectors are flagged. Admins and dispatchers can fill it in for someone from **Admin → Roster**.
3. **Roster by hand.** **Admin → Roster** lists every upcoming sector with its crew and what it still needs. Open one to get its own page: the times, the departure window, the seats, and **Who can fly this** — every pilot on the team with what they said about the sector, what they are already flying ("4 sectors · 2 CA, 1 FO"), their hours and back-of-clock count, and **every duty rule that rostering them would break**, written out in full. Press a seat button (CA, FO, RP) to roster them, or press it again to take them off. Nothing is blocked: if you need someone on a flight, put them there and the rule check will keep reminding you. Do the whole roster this way if you like, or only pin the people who must fly a particular sector and let Auto roster do the rest.
4. **Auto roster.** **Admin → Roster → Auto roster the gaps** fills the empty seats. It never moves anyone already rostered, never uses someone who marked Can't, and stays inside the duty rules. Seats it cannot fill are listed. **Clear auto-rostered** removes only what it placed, so you can adjust and run it again.
5. **Check the share.** **Admin → Balance** shows every pilot's sectors broken down by seat (CA, FO, relief pilot), their block hours and their back-of-clock sectors, with a chip saying whether the totals are even or how far apart they are.
6. **Check and publish.** The rule check lists anyone whose roster breaks a rule (including people you pinned). **Publish roster** makes it visible to everyone.

The duty rules are edited in **Admin → Settings** and apply to the whole team: minimum rest, sectors per duty (one, so everyone rests between sectors), longest duty, sectors per person, the length over which a sector also carries a relief pilot (six hours, so those sectors are rostered with three pilots instead of two; set it to 0 to turn it off), the back-of-clock window how many back-of-clock sectors each person may fly in the event (two) and how far apart they must be (one every two days, so never on consecutive nights), report times, how far a delay must move a report time before the Ops board asks about it, and whether everyone counts as available unless they say otherwise (on by default, so a pilot only marks the sectors they want or cannot fly). Sectors with less than the minimum rest between them count as one duty.

Auto roster is a sensible-rules fill, not a perfect optimiser: it works through the sectors in order, evening out the number of sectors each person flies and the time they spend in each seat, favouring sectors people asked for and keeping a crew together on back-to-back sectors. Expect to adjust a few by hand.

### Reading your own roster

**My Roster** and **Open seats** show, under each sector's number and sign-on
time, **how long the duty runs and when you sign off** — in Zulu and then in
sim local (Sydney) time, since that is where you are sitting. Duty is measured
from signing on to on blocks at the far end, the same two ends the team's
duty-hours rule measures between, so what you read is what the rule check
counts.

Each seat has its own colour, so a glance says which one you are in rather
than only that you are rostered: **red** Captain, **yellow** First Officer,
**blue** Relief Pilot. An Observer keeps the plain grey badge.

A **UTC / Local** button at the top of the page says which of the two every
time on it leads with. The roster is planned in Zulu but flown by people living
in Sydney, so neither is the right one for everybody: press Local and the sim
local time comes first, with the Zulu one kept beside it, and the day headings
and dates follow — a sector departing 1330Z on 01 NOV is listed under 02 NOV,
because that is the night you are actually flying it. Nothing is ever hidden,
and no time can be read as the wrong one: each carries its own `Z` or `AEDT`.
The choice is remembered on your own device. The published departure window
stays in Zulu, as WorldFlight publishes it.

Between two of your own sectors, My Roster draws a yellow **Off duty for 11h
30m** band with the window it covers, so your breaks are as easy to find as
your flying. Back-to-back sectors flown in one duty leave no gap, so nothing is
drawn between them — only a real break shows.


### Accounts

Every account is made by an admin, in **Admin → People and roles**. Somebody who
has not set theirs up yet is marked **NOT SET UP**, which means they have not
signed in for the first time. **Remove** deletes an account for good and takes
the person off every sector they were rostered on.

Test accounts have been removed. If an old database still has some, running
[`supabase/accounts.sql`](supabase/accounts.sql) deletes them and takes away the
functions that made them.

### After updating the app

When a new version changes the database (new roles, new schedule times), run `supabase/schema.sql` and then `supabase/schedule.sql` again in the SQL Editor. Both are safe to re-run and keep your accounts and roster, and re-running the schema does not reset a tablet password you have changed.

A version that changes **who may do what** needs the file that holds that rule
re-run as well, because the database enforces it rather than taking the app's
word for it. Dispatchers were taken out of the ops desk in the version that
moved the ACARS company message to the Ops Board, so run
[`supabase/ops-chat.sql`](supabase/ops-chat.sql),
[`supabase/ops-chat-notify.sql`](supabase/ops-chat-notify.sql) and
[`supabase/ops-call.sql`](supabase/ops-call.sql) again if you had them. Until
you do, a dispatcher keeps being notified about a thread the app no longer
gives them. All three are safe to re-run.

This version stopped the app moving report times on its own. Run
[`supabase/notifications.sql`](supabase/notifications.sql) again so it stops
sending the old automatic notice, then
[`supabase/crew-confirm.sql`](supabase/crew-confirm.sql) and
[`supabase/report-shifts.sql`](supabase/report-shifts.sql), in that order, for
the confirmations and the Ops board's report-time decisions. All three are safe
to re-run. Until the last two have been run the app simply leaves both out:
report times are the published ones and nothing is held.

### If the WorldFlight schedule changes

Nothing to run: the database watches for it. [`supabase/worldflight.sql`](supabase/worldflight.sql) sets up a job inside Supabase that reads <https://planning.worldflight.center/schedule> every six hours, parses the 43 sectors out of it and keeps them in a table of their own, `official_schedule`. It uses two free Supabase extensions, `http` and `pg_cron`, and the file turns both on.

Admins and dispatchers then see it in the app:

- a banner on the Dashboard — **WorldFlight schedule changed · 4 sectors differ from the official one**;
- a card at the top of **Schedule** listing exactly what moved (departure and arrival times, airports, the departure window, the route) and any new sectors;
- one button, **Update N sectors**, which writes them to the team's schedule. Roster entries, sector notes and briefings all stay where they are, and sectors you added yourself are listed but never touched.

Nothing is applied to the database on its own, so a change to the official programme can never quietly move a sector somebody is about to fly. When the two match, the Schedule page says so.

The Schedule page says when the site was last read ("Read from the WorldFlight site 36m ago"), and if a check fails it says so and why, rather than going quiet — the copy it read before that is kept and used. If WorldFlight ever rebuilds the page, the check fails loudly in that line instead of writing nonsense into the table.

Until that SQL is run, the app compares against the copy it was built with (`js/data/schedule.js`), which is rebuilt by `tools/build_schedule.py`. To read the site by hand at any time, run `select public.refresh_official_schedule();` in the SQL Editor.

### Sectors with two routes

A few sectors each year are published twice: the same departure window and the
same block time, but two ways round, and each team flies one of them. In 2026
there are two such runs:

| | Route A | Route B |
| --- | --- | --- |
| WF2619–WF2621 | SKBO → TBPB → GVAC → DNMM | SKBO → TTPP → GVSV → DNMM |
| WF2631–WF2632 | EINN → EGSS → EHAM | EINN → EGKB → EHAM |

Both routes live on the one sector, rather than as a second set of sectors, and
that is the whole trick: **the crew is rostered on the sector, so whoever is
rostered flies it whichever way round the team goes.** Switching a run over
keeps every roster entry, report time, note and handover exactly where it is —
the aeroplane is simply going somewhere else.

On the **WF Schedule** a card shows both routes with the one being flown marked
**FLYING**, and each affected sector in the list carries a `ROUTE A` or
`ROUTE B` badge. An admin or dispatcher presses **Fly route B** (or A) and the
whole run goes over at once, after a confirmation naming the airports. It has to
be the whole run: flying WF2619 to TTPP and then WF2620 out of TBPB would leave
the aeroplane in the wrong ocean, so the app works out which sectors belong to a
run — by following where both routes join up — and the database moves them
together or not at all.

Switching does drop any **imported flight plan** on the sectors that moved: it
was built for the other route's airports, so leaving it there would brief a
crew on a flight they are no longer making. The confirmation says how many will
go, and they are one press to import again. Nothing else in the briefing is
touched.

Everybody else sees which way the team is going: the sector's briefing says
"Route B of two" and names the other way round. The congestion forecast
re-checks itself against the new destination.

Editing one of these sectors by hand edits **route A**; route B is
WorldFlight's own and is read from their site. Switching the route is the
button, not the form.


### Giving a sector away

Somebody who cannot make a sector after all opens it from the Roster, presses **I cannot fly this**, and says why. They stay rostered on it, so nothing is ever left uncovered while it is being sorted out.

Everyone else sees it in **Cover needed** at the top of the Roster, with any duty rule it would break for them written out. Taking it marks it claimed; an admin then agrees it in **Admin → Roster**, where the same rule warnings are shown, and the sector moves across. Both people are told. Turning it down puts it back on offer, and the person who offered it can take the offer back at any point with **Keep this sector after all**.

Nothing about this bypasses the duty rules: it shows them and lets a person decide, in the same way rostering by hand does.

## The map, and how far round the world

The Dashboard draws the sector being flown: the great-circle track from the
departure airport to the arrival one, with the aeroplane on it, turned the way
it is pointing. It is drawn from the same position the rest of the card uses,
so it follows the simulator API when that is set up and VATSIM otherwise, and
it keeps the last known position when the aeroplane goes offline.

**Logbook** (in the navigation, and a tile on the Dashboard) puts the whole event on one map: every
sector flown so far in solid blue, the one in the air in red, and the rest
dashed. Under it are the sectors flown, the distance covered against the whole
route, the block time and the airports visited.

The same page carries **crew hours**: every pilot with the sectors they have
flown, their hours, their miles and which seats they sat in, with your own row
marked. A sector counts once the flight deck stamps on blocks, or once its
arrival time has passed, so the logbook fills in as the event runs rather than
showing the plan. Block time is what was really stamped, falling back to the
scheduled time where nobody stamped anything.

The coastlines are Natural Earth 1:110m land, in the public domain, cut down to
[`js/data/world.json`](js/data/world.json) (about 60 KB) so the map works with
no connection and needs no mapping service.

## Weather and who is controlling

Each airport page shows the **METAR** (what it is doing now) and the **TAF**
(what it is forecast to do), and then **who is controlling the airport on
VATSIM** right now with the **ATIS** they are putting out, word for word.

The METAR, the controllers and the ATIS all come straight from VATSIM and need
no setting up. The TAF is different: the weather service that publishes
forecasts for the whole world does not let a browser read it directly, so
[`supabase/weather.sql`](supabase/weather.sql) has the database read it instead
and keep each forecast for fifteen minutes. Until that file is run, the airport
pages say so and show everything else.

There is no one way VATSIM names a station. Much of the world uses the whole
ICAO code (`EGLL_TWR`), the United States drops the country letter (`KDFW` ->
`DFW_TWR`) and Australia uses the two-letter local code (`YSSY` -> `SY_TWR`).
Sydney uses both at once: `YSSY_ATIS` alongside `SY_TWR`. So all three forms
are matched and the results merged, and the page says which ones it used.

A callsign only counts if it also ends in a position worked at the airport
itself: `_DEL`, `_GND`, `_TWR`, `_APP`, `_DEP` or `_ATIS`. That is what keeps a
short code like `SY_` from sweeping up something unrelated on the other side of
the world.

Area control (`_CTR`) is left out on purpose. An enroute sector is not an
airport station, its frequency moves about as sectors are split and combined,
and it is often not published at all.

## Official WorldFlight airport briefings

The team controlling each destination publishes its own **pilot briefing** on
the WorldFlight planning site, often with an **aerodrome chart** and a
**parking and docking chart** drawn for the event. They are what the
controllers expect the crew to have read, and they go up over the days leading
into the week rather than all at once.

The app lists them in two places: on each **sector briefing**, for the
departure and the arrival together, and on the **airport's own page**. The
documents are not copied into the app — each one is a link straight to
WorldFlight's own file, so what opens is always the current version.

The list comes from the planning site's own listing, which does not let a
browser read it directly, so [`supabase/airport-docs.sql`](supabase/airport-docs.sql)
has the database read it instead and keep each airport's list for two hours.
The refresh button asks again straight away. Until that file is run, the
briefings say so and show everything else.

Names differ from airport to airport (`PILOT BRIEFING VHHH`,
`VATROC RCTP PILOT BRIEFING AH`, `DUBAI PILOT BRIEF ARRIVALS`) and some
airports publish several documents while most publish none yet, so nothing is
guessed: whatever WorldFlight has listed for that airport is what shows.

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
- on your own sector card, a line saying what the delay suggests your report time should be, while the time you report to stays the published one.

Nothing is shown until somebody stamps a time or the aircraft is being tracked, and estimates are rounded to five minutes, because a guess printed to the minute reads as more certain than it is. Stamped times are shown exactly. **Minimum turnaround** and **Taxi in** are in **Admin → Settings**, so the whole team works from the same numbers.

The estimate takes the best source it has, in this order: a stamped time, the simulator API, the live VATSIM position, then the published block time. With nothing connected at all it is simply the published schedule, which is where you started.

### Report times, and who moves them

**A delay never moves a report time by itself.** It used to: the estimate was laid over whatever you were rostered with and that was the time on your card. It was never wrong, and it was never decided by anybody either — one stamped time in Jakarta quietly moved the moment somebody in another time zone would set an alarm for, and there was nobody to ask about it.

So now it asks. A delay that would move a report time by more than the team's threshold (**Admin → Settings**, 20 minutes), on a sector whose crew report within the next few hours (6), is raised on the **Ops board** under **Report times to decide**, grouped by the sector the delay is on, with every seat it lands on. The controller on shift has three choices per seat, or for the whole sector at once:

- **Move to 1215Z** — take the proposal. Each seat keeps the lead it was rostered with, so three pilots on one aeroplane move together but not onto the same minute.
- **My own time** — type a report time in Zulu. The aeroplane is not the only thing a controller knows about.
- **Leave it** — the published time stands. The proposal is remembered as the mark the next estimate is measured against, so waving twenty minutes away does not mean being asked about the same twenty minutes a minute later.

Approving writes the new time onto the roster entry, which is the only report time anything in the app reads. The pilot is notified and has to confirm it (below) before they can carry on. Until then everybody reports at the time they were given, and the board, the roster and the Dashboard all say that one time.

The ops controllers on shift are notified when proposals are raised — one message per sector, not one per seat — if they have turned notifications on. Needs [`supabase/report-shifts.sql`](supabase/report-shifts.sql).

### Confirming a change to your roster

A pilot reads the roster once, in the morning, and then flies the day from memory, so a change nobody acknowledged is worse than no roster at all. Anything that changes what one person is doing — put on a sector, taken off one, another seat, a new report time, or the sector itself moving — stops the app on a single page listing what changed, and nothing else works until they press **I have read this**.

It counts changes they caused themselves: taking somebody's sector in a swap is exactly the moment a day is in somebody's head wrong. Ops staff are told the same way but never held, since locking the desk out of the board it is working would make a bad day worse; their own changes appear on the Ops board instead, under **Roster changes**, beside everybody else's — so the desk can see who has read a change and who has not before ringing anybody about it. Needs [`supabase/crew-confirm.sql`](supabase/crew-confirm.sql).

## Rostering the ops desk

**Admin → Ops Desk** holds the controllers' own roster, and it is worked the way the Landscape view is: one row per person who can take the desk, a day of hours across the top, and a bar for every shift. Nothing is typed unless you want to type it.

- **drag across an empty row** and a shift appears where you drew it;
- **drag either end of a bar** to change when that shift starts or finishes;
- **drag the middle** to move the whole thing, or onto another row to hand it to that controller;
- **tap a bar** for the exact times, a note, and **Remove**.

Everything lands on the quarter hour, nothing is written until you let go, and **Escape** gives up on a drag half way through. Pick the day from the list, and **UTC / Local** reads the hours in Zulu or in Sydney time — the roster is written in one and lived in the other.

Above the rows is the strip the page is really for: **Desk cover**, green where somebody has the desk and striped red where nobody does, with the open time counted in the margin. A gap at 0300 is what the roster is written to close, and reading that off a list of start and end times was the hard part. Behind the bars, faintly, are the sectors being flown, so the desk can be rostered against the flying rather than against the clock.

Overlapping shifts are allowed on purpose — two controllers covering the same hours is a real thing, and whoever started first holds the desk until the other's shift begins. On a touch screen a finger still scrolls the timeline, so drawing a *new* shift by dragging wants a mouse or a stylus; existing bars drag and resize under a finger, and the form at the foot of the page adds one by typing. Needs [`supabase/ops-chat.sql`](supabase/ops-chat.sql).

## Destination congestion forecast (holding and traffic fuel)

Opening a sector's **Briefing** checks the destination and turns what it finds into a recommended extra fuel load on the **Plan in SimBrief** link below, so holding does not come as a surprise with the tanks already loaded:

- **Traffic** – other pilots on VATSIM filed into the same airport, with an ETA (their distance to run over their present ground speed, the same maths the Dashboard uses for the team's own aircraft) within 45 minutes of ours, charted either side of our own ETA. Pilots still on the ground there, filed to depart, are counted too, since they share the same runway and airspace. A prefiled flight with nobody connected yet is not counted, because there is no position to work an ETA from.
- **Weather** – not the current METAR, but the **TAF read for the moment we are expected to land**, since that is what the holding is actually for. It is sorted into VFR, MVFR, IFR or LIFR, the same categories a controller thinks in, reading whichever FM or BECMG period of the forecast covers our ETA (a momentary TEMPO or PROB is left out, as it is not the prevailing forecast). Falls back to the current METAR where there is no TAF, which needs [`supabase/weather.sql`](supabase/weather.sql); without it, or beyond the end of the published forecast, the nearest thing available is used.
- **ATC coverage** – who is on frequency at the destination right now, the same VATSIM data the airport's own page reads.

```
band     = Light (<10 arrivals) · Moderate (10-19) · Busy (20-29) · High (30-39) · Severe (40+)
         bumped up a band for IFR, two for LIFR
minutes  = 15 · 30 · 45 · 60 · 90, one per band
score    = 0-100, traffic scaled against 45 arrivals, weather added on top
```

That recommendation is only a starting point: the **Destination congestion forecast** card has its own slider, 0 to 90 minutes in steps of five, so the crew can take more or less than it suggests. Whatever the slider is set to is what goes to SimBrief as **Extra Fuel**, in minutes rather than a weight, so SimBrief works out the actual fuel from the aeroplane's own performance rather than this app guessing at a burn rate; the **Plan in SimBrief** link shows how much it is carrying. The card has its own refresh button, and a chosen value survives a refresh rather than being overwritten by the next recommendation. None of this is a feed from ATC — treat it the way you would a glance at the arrivals board, not a clearance.

## How it looks

The palette lives in one place, the `:root` block at the top of [`css/app.css`](css/app.css), and everything else refers to it. It is an unofficial Qantas-inspired set: brand red (`#E4002B`, deepening to `#BA0C2F`) on a near-black flight deck grey, with steel blues for anything that is only information.

Red is rationed on purpose. It marks the brand, the page you are on, and the one action a card is really for. Everything that is merely a state keeps its own colour — green for done, amber for needs attention, red-orange for a problem — so an alert still stands out when the brand is red too. Times are set in tabular figures so columns of them line up, sub-headings are ruled off across the line like the headings on an ops form, and the stripe under the header and beside the open nav item is the same shape as the one on the mark.

On a phone the navigation sits along the bottom under your thumb; from 900px it becomes a labelled sidebar. There is no light theme: the app is read in a dim sim room at three in the morning.

## Notifications

The app can notify a phone even when it is closed. Four things are sent, and nothing else:

- **the roster is published** — with how many sectors you have and when the first one is;
- **your own sectors change** — added, taken off, duty or report time moved. Whatever it is, it is also waiting for you to confirm when you open the app;
- **a delay needs a report time moved** — to the ops controllers only, one message per sector, because it is theirs to decide;
- **a reminder** a set time before you report.

Each person turns it on in **Settings → Notifications**, on each device they want told, and chooses which of the four they want and how early under **Notification settings** — those choices follow the person, so they are the same on their phone and their iPad. The numbers in **Admin → Settings** are only the starting point for somebody who has not chosen. Nobody is sent anything until they turn it on. On iPhone and iPad it only works once the app has been added to the Home Screen and opened from there; the app says so rather than failing silently.

### Setting it up

This is the one part of the app with a piece outside Supabase's SQL editor: the sending has to be signed, which needs a small function running somewhere. Supabase runs it for free.

1. In Supabase, open **Edge Functions → Deploy a new function**, name it exactly `send-push`, and paste in the whole of [`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts). Deploy it. Its address is then `https://YOUR-PROJECT.supabase.co/functions/v1/send-push`. Supabase will not run a function at all without an `Authorization` header, so either turn **Verify JWT** off for this one (its own shared secret is the real check) or leave it on — the database sends the publishable key as well, which satisfies it.
2. Open the SQL Editor and paste in [`supabase/notifications.sql`](supabase/notifications.sql). Three lines are marked `<= fill in`: the VAPID private key (the public half is already in `js/config.js`; whoever set this up has the private half), that function address, and any long random string as a shared secret so only the database can call the function. Fill them in **in the editor, not in the file**, because this repository is public. Press Run. Those three are only written the first time, so running the file again later — for a new version of the app — keeps them and you never paste them in twice. To change one, run `update public.push_config set secret = 'the new one' where id;`.
3. Open the app, go to **Settings → Notifications** and turn it on. Press **Show me one** to check it appears.

The database builds the messages and asks the function to deliver them every ten seconds. A message is encrypted for the one device it is going to ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), so the push service that carries it cannot read it. A device that has uninstalled the app or turned notifications off is dropped automatically the next time something is sent to it.

If notifications stop working, run `select public.push_tick();` in the SQL editor: it returns what it did, and the `error` column on `public.notifications` keeps the reason against each message. `403 ... BadJwtToken` from the push service means the signature was refused: either the contact address in `push_config.subject` is not a real `https://` address or `mailto:`, or the device subscribed with a different key than the database is signing with. Turning notifications off and on again on that device fixes the second — the app now notices a subscription made with an older key and replaces it.

## Install it on a phone or tablet

- **iPhone / iPad:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap **⋮**, then **Install app** (or **Add to Home screen**).

## The aeroplane, and device settings

There is one aeroplane, so there is one set of answers about it. The **VATSIM callsign**, the **aircraft type**, an optional **custom airframe** and the **team SimBrief account** are set once in **Admin → SimBrief**, by an admin or operations, and everyone's app follows them.

A custom airframe is one saved in the team's SimBrief account with its own weights, cabin layout and registration. Put its **internal ID** (from Aircraft in SimBrief, something like `123456_1582090020`) in that field and the app sends it in place of the aircraft type, so every sector is planned with that aeroplane rather than a generic one. Leave it empty and the ICAO type is used. The page shows the real link for the next sector, so a change can be checked before anybody uses it. It needs [`supabase/simbrief.sql`](supabase/simbrief.sql), which stops anybody but an admin or operations changing any of it. Nobody sets their own: a pilot pointing the app at their own callsign would quietly stop seeing the team's aircraft on the Dashboard, and a second SimBrief account would mean two crews briefing different flight plans.

**Settings**, under your initials in the top right, is left with the one thing that really does belong to a device: the **Simulator status API address**, which only the computer at the sim normally needs (see below). Leave it blank to use VATSIM.

## Simulator status API

The Dashboard can read the aircraft's position, phase, ETA and fuel straight from the simulator instead of VATSIM. The format the simulator side has to publish is defined in [docs/API.md](docs/API.md), with an example in `api/status.example.json`. Nothing publishes it yet; that connector is still to be built.

## Sector briefings

The **Briefings** tab opens the briefing for the next sector (pick any other from the drop-down, or tap a sector on the **WF Schedule**, which opens straight into its briefing). It is saved in the team database, so everyone sees the same thing:

- **Weather** – the METAR and TAF for both the departure and arrival airports, right there on the page, so a pilot does not have to leave the briefing just to check them. The airport's own page (still reachable from the DEP/ARR briefing buttons) adds runways, who is controlling it on VATSIM, and the team's notes.
- **Official WorldFlight briefings** – the pilot briefing published by the team controlling each end of the sector, and the aerodrome and parking charts they draw for the event, listed for the departure and the arrival side by side and opened straight from the WorldFlight site. See below.
- **Destination congestion forecast** – see above.
- **Flight plan (OFP)** – imported from SimBrief and saved for the whole team. An admin or dispatcher sets the team's one SimBrief username or Pilot ID on the briefing page; until then each person imports from their own account in Settings. A plan for a different sector is refused.
- **Which route**, for the few sectors WorldFlight publishes two ways round: the briefing says which one the team is flying and what the other way is. See above.
- **Aircraft status** – open and deferred defects from the tech log, with their restrictions.
- **Handover** – what the previous sector's crew left for this one, and a box for this crew to leave theirs.
- **Team notes**, and **WorldFlight's page and briefing notes** for the sector (paste the address and their notes).

Every one of those is its own card with a chevron in the corner: fold away what you don't need and it stays folded while you work through the rest, so the page is as short or as long as you want it. Pilots, dispatchers and admins can write; observers read. The MEL lookup and the defect form also have a search box (try "radar" or "34-15").

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

## Checklists, and editing the normal ones

The **Normal** checklists are the team's own. Out of the box every device flies
the set in [`js/data/checklists.js`](js/data/checklists.js), Preflight to Secure.
Once `supabase/normal-checklists.sql` has been run, an **admin** gets two extra
buttons at the bottom of a normal checklist: **Edit this checklist** and
**Add a checklist**. Nobody else does, and the database enforces it as well as
the app: the whole list is written through one function, `set_normal_checklists`,
which refuses anyone who is not an admin. A dispatcher builds the roster, but the
checklists the crew reads out are the team's procedures.

The editor takes a challenge and a response per item — the call and the read-back
— and rows can be added, removed and moved. **Runs after** decides where the
checklist sits in the run, which is also what the **Next** button follows, so a
new **Taxi** checklist can go between Before Taxi and Before Takeoff rather than
on the end. A checklist can be deleted as long as one is left.

Two things happen on save, on purpose. The first save writes the whole list, so
from then on the team's list is what everyone flies and `js/data/checklists.js`
is only the set a fresh team starts from. And because ticks are kept by item
position on each device, changing a checklist's wording clears that checklist's
ticks everywhere and marks it not complete — once the wording has moved, a page
of ticks against the old wording would be a lie, and so would telling the other
EFB it is done.

**Non-normal** checklists are not editable, by anyone. They are the extracted
QRH, with their own numbering, branches and jumps between procedures, and are
rebuilt from the source PDF with `tools/build_qrh.py` rather than reworded in
the app.

## Airport notes

These are still saved on each person's own device, not in the database. To share them, use **Settings → Export**, send the file to the team, and they use **Import**.

## Changing things

| To change | Edit |
|---|---|
| Normal checklist wording, order, and adding a checklist | in the app: **Checklists → Normal → Edit** (admins only; needs `supabase/normal-checklists.sql`) |
| The normal checklists a fresh team starts from | `js/data/checklists.js` |
| Non-normal checklists | rebuild `js/data/non-normal.js` with `tools/build_qrh.py`; they are the QRH and are not editable in the app |
| Colours and layout | `css/app.css` |
| Callsign, aircraft type, custom airframe and team SimBrief | in the app: **Admin → SimBrief** |
| Duty rules, report times and the report-move threshold | in the app: **Admin → Settings** (starting values are in `js/autoroster.js`) |
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
- Airport briefings and charts: the official [WorldFlight planning site](https://planning.worldflight.center/), as each controlling team publishes them. Published PDFs are cached locally for the in-app zoom viewer; their original source URLs and revisions are recorded in `docs/worldflight/manifest.json`.
- Flight plans: SimBrief's "latest OFP" service for your username.
- Schedule: the official [WorldFlight planning site](https://planning.worldflight.center/schedule), as published on 26 October 2026, including the alternative routes for the sectors offering two.
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain). Rebuild with `tools/build_airports.py`.
- Charts are not embedded; Navigraph's licence does not allow that, so the app links out to the official sites.

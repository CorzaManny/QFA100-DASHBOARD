// The one endpoint the vPilot plugin talks to.
//
//   POST .../vpilot-plugin           { events: [...] }  -> { instance }
//   GET  .../vpilot-plugin?after=N                      -> { instance, commands }
//
// Deploy with JWT verification off: the caller is a plugin inside vPilot on
// the pilot's PC, not a signed-in person, so it has no JWT. It proves itself
// with the key it made on its first run (Authorization: Bearer ...), which
// this hashes and hands to vpilot_authenticate() - that claims the EFB for the
// first plugin it sees and refuses every other key until an admin calls
// vpilot_forget_plugin().
//
//   supabase functions deploy vpilot-plugin --no-verify-jwt
//
// Everything else it does is three calls into supabase/vpilot.sql, so the
// event handling stays where a whole batch lands at once. This is auth, the
// long poll, and nothing more.
//
// The GET is held open up to 25 s. vPilot's own HTTP client gives up at 40 s,
// so this must always answer before then, with an empty list if there is
// nothing for vPilot to do.
//
// Both answers also carry a "settings" object, which is how the one secret
// the bridge is not allowed to keep on disk reaches it: the Hoppie ACARS
// logon code. It is read here with the service role and handed only to a
// bridge that has already proved itself with its key, and it never goes to a
// browser. It deliberately does not travel as a queued command, because a
// command sits in vpilot_commands, which every signed-in tablet can read.

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const HOLD_MS = 25_000;
const LOOK_EVERY_MS = 1_000;
// The plugin's own key is 43 characters; anything shorter is not one of ours.
const MIN_KEY_LENGTH = 32;

type Command = { id: number; type: string; args: Record<string, unknown> };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// What the bridge needs from the EFB but does not store: the Hoppie logon
// code and the ACARS callsign.
//
// Undefined when supabase/acars.sql has not been run, which is a database
// with no ACARS at all - the RPC simply is not there. That must not fail the
// request: the bridge's radio and simulator do not depend on it, and a bridge
// wedged on a missing ACARS table would take those down with it.
async function settings(): Promise<Record<string, unknown> | undefined> {
  try {
    return await rpc<Record<string, unknown>>("acars_bridge_config", {});
  } catch (err) {
    console.warn("acars_bridge_config:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

// The instance id, or null when this key is not the plugin that claimed the EFB.
async function claim(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const key = header.slice("bearer ".length).trim();
  if (key.length < MIN_KEY_LENGTH) return null;
  return await rpc<string | null>("vpilot_authenticate", { key_hash: await sha256Hex(key) });
}

Deno.serve(async (req: Request) => {
  if (!PROJECT_URL || !SERVICE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
    return json(500, { error: "The EFB is not set up for vPilot." });
  }

  let instance: string | null;
  try {
    instance = await claim(req);
  } catch (err) {
    console.error("vpilot_authenticate:", err);
    return json(503, { error: "The EFB could not check the plugin's key." });
  }
  if (!instance) {
    // The plugin shows this in vPilot's message window and keeps retrying, so
    // one line per refusal is enough to find it in the logs.
    console.warn("Refused a vPilot plugin key.");
    return json(401, { error: "This EFB is linked to a different vPilot plugin." });
  }

  try {
    if (req.method === "POST") {
      let events: unknown[] = [];
      try {
        const body = await req.json();
        if (body && Array.isArray(body.events)) events = body.events;
      } catch {
        return json(400, { error: "That was not JSON." });
      }
      const [ingested, config] = await Promise.all([
        rpc<string>("vpilot_ingest", { events }),
        settings(),
      ]);
      return json(200, { instance: ingested, settings: config });
    }

    if (req.method === "GET") {
      const asked = Number(new URL(req.url).searchParams.get("after") ?? "0");
      const after = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
      const until = Date.now() + HOLD_MS;
      for (;;) {
        const commands = await rpc<Command[]>("vpilot_take_commands", { after });
        // The settings go out with the commands as well as with an empty
        // poll, so a logon code set while a command was waiting still reaches
        // the bridge on this answer rather than on the next one.
        if (commands.length > 0) return json(200, { instance, commands, settings: await settings() });
        if (Date.now() >= until) break;
        await sleep(LOOK_EVERY_MS);
      }
      // Nothing to do. The instance is read again on the way out, so a resync
      // asked for during the poll reaches the plugin now rather than 25 s from
      // now.
      const [fresh, config] = await Promise.all([claim(req), settings()]);
      return json(200, { instance: fresh ?? instance, commands: [], settings: config });
    }

    return json(405, { error: `${req.method} is not how to talk to this.` });
  } catch (err) {
    console.error(`${req.method}:`, err);
    return json(503, { error: "The EFB could not reach its database." });
  }
});

// Sends the team's notifications to people's phones.
//
// Paste this whole file into Supabase -> Edge Functions -> Deploy a new
// function, name it "send-push", and deploy. It is called once a minute by the
// job in supabase/notifications.sql; it never needs to be opened by hand.
//
// It takes whatever is waiting in public.notifications, encrypts each one for
// the device it is going to (RFC 8291) and posts it to that device's push
// service with a VAPID signature (RFC 8292). A subscription the push service
// no longer knows about is deleted, so dead devices tidy themselves up.
//
// This is written in plain JavaScript on purpose: no imports, nothing to
// install, and the same file runs in a browser, which is how the encryption
// below was checked against the worked example in RFC 8291.

const enc = new TextEncoder();

export function bytesToB64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// One HKDF step: extract with the salt, expand with the info.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// A P-256 private key, from the 32-byte scalar and the public point beside it.
function importPrivateKey(privateB64, publicB64, usages) {
  const pub = b64urlToBytes(publicB64);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateB64,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const algorithm = usages.includes('sign')
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'ECDH', namedCurve: 'P-256' };
  return crypto.subtle.importKey('jwk', jwk, algorithm, false, usages);
}

// The message body, encrypted so that only the subscribed device can read it:
// RFC 8291 key agreement inside the RFC 8188 aes128gcm content coding.
//
// `fixed` is only used by the test, which replays the worked example in the
// RFC; in use the salt and the sender's key pair are new every time.
export async function encryptPayload(payload, receiverPublicB64, authSecretB64, fixed) {
  const receiverPublic = b64urlToBytes(receiverPublicB64);
  const authSecret = b64urlToBytes(authSecretB64);
  const salt = fixed ? b64urlToBytes(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));

  let senderPrivate;
  let senderPublic;
  if (fixed) {
    senderPrivate = await importPrivateKey(fixed.senderPrivate, fixed.senderPublic, ['deriveBits']);
    senderPublic = b64urlToBytes(fixed.senderPublic);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }

  const receiverKey = await crypto.subtle.importKey(
    'raw',
    receiverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, senderPrivate, 256),
  );

  // The two public keys go into the derivation, so a message can only be read
  // by the device it was built for.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), receiverPublic, senderPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (and only) record.
  const record = concat(enc.encode(payload), new Uint8Array([2]));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

  // salt | record size (4096) | key length (65) | sender public key | ciphertext
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([65]), senderPublic);
  return concat(header, sealed);
}

// Proves to the push service that the message came from this app.
export async function vapidHeader(endpoint, vapid) {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const key = await importPrivateKey(vapid.privateKey, vapid.publicKey, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${bytesToB64url(signature)}, k=${vapid.publicKey}`;
}

export async function sendOne(subscription, payload, vapid, ttl) {
  const body = await encryptPayload(payload, subscription.p256dh, subscription.auth);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl || 3600),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidHeader(subscription.endpoint, vapid),
    },
    body,
  });
}

// ---- The bit that runs on Supabase ----

const URL_BASE = () => Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = () => Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function db(path, init) {
  const res = await fetch(`${URL_BASE()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function run() {
  const [config] = await db('push_config?select=*&id=eq.true');
  if (!config?.vapid_private) throw new Error('no VAPID keys saved; see supabase/notifications.sql');
  const vapid = { publicKey: config.vapid_public, privateKey: config.vapid_private, subject: config.subject };

  // Oldest first, and never more than a burst at a time.
  const waiting = await db('notifications?select=*&sent_at=is.null&order=created_at.asc&limit=200');
  let sent = 0;
  let gone = 0;

  for (const note of waiting) {
    const subs = await db(`push_subscriptions?select=*&user_id=eq.${note.user_id}`);
    const payload = JSON.stringify({ title: note.title, body: note.body, url: note.url, tag: note.kind });
    for (const sub of subs) {
      try {
        const res = await sendOne(sub, payload, vapid, note.ttl);
        if (res.status === 404 || res.status === 410) {
          // The device has unsubscribed or been wiped.
          await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' });
          gone += 1;
        } else if (res.ok) {
          sent += 1;
        } else {
          console.error('push rejected', res.status, await res.text());
        }
      } catch (err) {
        console.error('push failed', err.message);
      }
    }
    await db(`notifications?id=eq.${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ sent_at: new Date().toISOString() }),
    });
  }
  return { waiting: waiting.length, sent, gone };
}

if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve(async (req) => {
    // Called by the database once a minute with the shared secret.
    const [config] = await db('push_config?select=secret&id=eq.true').catch(() => []);
    if (!config || req.headers.get('x-push-secret') !== config.secret) {
      return new Response('no', { status: 401 });
    }
    try {
      return Response.json(await run());
    } catch (err) {
      console.error(err);
      return Response.json({ error: err.message }, { status: 500 });
    }
  });
}

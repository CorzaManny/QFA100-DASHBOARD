// Turning notifications on for this device, and off again.
//
// The browser gives us a subscription: an address its push service will accept
// messages at, and two keys that let only this device read them. We hand that
// to the team database; supabase/functions/send-push does the sending.

import { PUSH_PUBLIC_KEY } from './config.js';
import { savePushSubscription, deletePushSubscription, configured, getSession } from './api.js';

// The key goes to the browser as bytes, not as text.
function keyBytes(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// A subscription is tied to the key it was made with. If the team's key has
// changed since, the push service will refuse every message sent to it, so the
// old one has to go.
function madeWithOurKey(sub) {
  const used = sub.options?.applicationServerKey;
  // A browser that does not say which key was used gets the benefit of the
  // doubt, rather than being made to subscribe again every time.
  if (!used) return true;
  const a = new Uint8Array(used);
  const b = keyBytes(PUSH_PUBLIC_KEY);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!PUSH_PUBLIC_KEY;

// Why this device cannot be notified, in words, or '' when it can.
export function pushProblem() {
  if (!configured || !getSession()) return 'Notifications need an account.';
  if (!('Notification' in window)) return 'This browser cannot show notifications.';
  if (!('PushManager' in window)) {
    return window.matchMedia('(display-mode: browser)').matches
      ? 'On iPhone and iPad, add the app to your Home Screen first, then open it from there.'
      : 'This browser cannot receive notifications.';
  }
  if (!PUSH_PUBLIC_KEY) return 'Notifications are not set up for this team yet.';
  if (Notification.permission === 'denied') {
    return 'This device has blocked notifications. Allow them for this site in the browser settings.';
  }
  return '';
}

const registration = () => navigator.serviceWorker.ready;

// On, as far as the team is concerned: subscribed, and with the key the team
// is signing with now. One made with an older key cannot be delivered to, so
// it counts as off and turning it on again replaces it.
export async function pushEnabled() {
  if (!pushSupported()) return false;
  const sub = await (await registration()).pushManager.getSubscription();
  return !!sub && madeWithOurKey(sub);
}

// Asks for permission, subscribes, and tells the team database where to send.
export async function enablePush(label) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed on this device.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !madeWithOurKey(sub)) {
    // Take the old one out of the team database too; messages sent to it are
    // refused rather than reported as gone, so nothing else would remove it.
    await deletePushSubscription(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(PUSH_PUBLIC_KEY),
  });
  const json = sub.toJSON();
  await savePushSubscription({
    endpoint: sub.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    label: label || deviceLabel(),
  });
  return true;
}

export async function disablePush() {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await deletePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

// Something to recognise this device by in a list.
export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

// Shows a notification from the app itself, so someone can see what one looks
// like without waiting for the roster to change.
export async function testNotification() {
  const reg = await registration();
  await reg.showNotification('QFA100 Ops', {
    body: 'Notifications are working on this device.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'test',
    data: { url: '#/settings' },
  });
}

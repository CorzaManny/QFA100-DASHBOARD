// Getting the app onto the home screen.
//
// Chrome and Edge let a page ask: they fire beforeinstallprompt, which can be
// held onto and fired later from a button of our own, and that opens the real
// install dialog. Safari on iPhone and iPad has no such thing -- Apple does not
// let a page start an install -- so there the best anyone can do is say where
// the Share button is and what to tap. Both are worth doing: on iOS the app has
// to be on the home screen before notifications work at all.

import { rerender } from './ui.js';

const DISMISSED = 'qfa100-ops.install-dismissed';
const QUIET_DAYS = 14;

// The event Chrome hands over, kept until somebody presses Install.
let offer = null;
let installed = false;

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: fullscreen)').matches ||
  // Safari's own flag, which is all iOS gives us.
  navigator.standalone === true;

// iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const dismissedAt = () => {
  try {
    return Number(localStorage.getItem(DISMISSED)) || 0;
  } catch {
    return 0;
  }
};

const quiet = () => Date.now() - dismissedAt() < QUIET_DAYS * 86400000;

export function dismiss() {
  try {
    localStorage.setItem(DISMISSED, String(Date.now()));
  } catch {
    // storage unavailable; it will simply ask again next time
  }
}

// What, if anything, is worth showing: 'chrome' for a real install button,
// 'ios' for the Share instructions, or '' for nothing at all.
export function installState() {
  if (installed || isStandalone() || quiet()) return '';
  if (offer) return 'chrome';
  return isIos() ? 'ios' : '';
}

// Opens the browser's own install dialog. Only Chrome and Edge have one, and
// the event can only be used once, so it is let go either way.
export async function install() {
  if (!offer) return;
  const event = offer;
  offer = null;
  try {
    event.prompt();
    const { outcome } = await event.userChoice;
    // Turning it down is an answer: stop asking for a fortnight.
    if (outcome !== 'accepted') dismiss();
  } catch {
    // The browser refused to show it; nothing more we can do.
  }
  rerender();
}

// Chrome fires this when the app qualifies to be installed. Holding onto it
// stops the browser's own small bar and lets the app ask in its own words.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  offer = e;
  rerender();
});

window.addEventListener('appinstalled', () => {
  installed = true;
  offer = null;
  rerender();
});

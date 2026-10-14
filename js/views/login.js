// The first page: signing in, and the setting up that follows an account an
// admin has just made. Nobody signs themselves up.

import { state, save } from '../store.js';
import { configured, signIn, signOut, getSession, requestReset, setPassword, finishSetup } from '../api.js';
import { EFB_DOMAIN, EFB_LOGINS } from '../config.js';
import { esc, icon, rerender } from '../ui.js';
import { syncTeam, clearTeam, isPending, needsSetup, me } from '../ops.js';

let mode = 'signin'; // signin, forgot (ask for a reset email) or newpass (arrived from that email)
let error = '';
let notice = '';
let busy = false;
let email = '';

function notConnected() {
  return `
    <section class="card">
      <h2>Accounts are not connected yet</h2>
      <p class="note">Sign-in needs the team's database. Whoever looks after this app follows "Set up accounts" in the README (about ten minutes, free), and this page becomes the login.</p>
      <p class="note">Until then you can use the app on this device without an account. The roster is not available in this mode.</p>
      <button class="btn primary" data-act="preview">Continue without an account</button>
    </section>`;
}

function awaitingApproval() {
  return `
    <section class="card">
      <div><span class="badge warn">AWAITING APPROVAL</span></div>
      <h2>Thanks, ${esc(me()?.display_name || '')}. Your account is waiting for an admin.</h2>
      <p class="note">A team admin needs to approve <strong>${esc(getSession()?.email || '')}</strong> before you can see the schedule and roster. Let them know you have signed up; this page updates by itself once you are approved.</p>
      <div class="btn-row">
        <button class="btn primary" data-act="recheck" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check again'}</button>
        <button class="btn ghost" data-act="signout">Sign out</button>
      </div>
    </section>`;
}

// An admin made this account with a placeholder address and a password they
// passed on. Nothing else opens until the person makes it their own.
function setup() {
  return `
    <form class="card form" data-form="setup">
      <div><span class="badge warn">FINISH SETTING UP</span></div>
      <h2>Welcome, ${esc(me()?.display_name || '')}.</h2>
      <p class="note">Your account was made for you by an admin. Put in your own email address and choose a password, and you are in. You will sign in with these from now on.</p>
      <label class="field">Your email<input name="email" type="email" required autocomplete="email" autocapitalize="none" autocorrect="off" placeholder="you@example.com"></label>
      <label class="field">New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field">New password again<input name="again" type="password" required minlength="8" autocomplete="new-password"></label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : 'Save and continue'}</button>
        <button class="btn ghost" type="button" data-act="signout">Sign out</button>
      </div>
      <p class="tiny">At least 8 characters. Nothing is emailed to you; the address is so the team knows who you are and so you can reset your own password later.</p>
    </form>`;
}

function forgot() {
  return `
    <form class="card form" data-form="forgot">
      <h2>Reset your password</h2>
      <p class="note">Enter the email you signed up with and we will send a link to choose a new password.</p>
      <label class="field">Email<input name="email" type="email" required autocomplete="email" autocapitalize="none" value="${esc(email)}"></label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : 'Send reset link'}</button>
        <button class="btn ghost" type="button" data-act="mode" data-mode="signin">Back to sign in</button>
      </div>
    </form>`;
}

function newPassword() {
  return `
    <form class="card form" data-form="newpass">
      <h2>Choose a new password</h2>
      ${getSession() ? `<p class="note">For <strong>${esc(getSession().email)}</strong>.</p>` : ''}
      <input type="email" name="username" autocomplete="username" value="${esc(getSession()?.email || '')}" hidden readonly>
      <label class="field">New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : 'Save new password'}</button>
        <button class="btn ghost" type="button" data-act="cancelReset">Cancel</button>
      </div>
      <p class="tiny">Use at least 8 characters.</p>
    </form>`;
}

// True while someone is choosing a new password, so the app stays on this page.
export const resetting = () => mode === 'newpass';

// Called when the app is opened from a link in an email. link: URLSearchParams
// of the address; signInWith(): signs in with the link.
export async function emailLink(link, signInWith) {
  if (link.has('error_description')) {
    mode = 'forgot';
    error = `${link.get('error_description')}. Ask for a new link.`;
    return;
  }
  const recovery = link.get('type') === 'recovery';
  if (recovery) mode = 'newpass';
  busy = true;
  try {
    await signInWith();
    await syncTeam();
  } catch (err) {
    if (recovery) mode = 'forgot';
    error = `That link did not work (${err.message}). Ask for a new one.`;
  }
  busy = false;
  rerender();
}

// A cockpit tablet signs in as "captain" or "first officer" rather than with
// an email address, so a name is turned into the address behind that account.
const efbName = (value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
export const isEfbLogin = (value) => !value.includes('@') && EFB_LOGINS.includes(efbName(value));
const signInAs = (value) => (isEfbLogin(value) ? `${efbName(value)}@${EFB_DOMAIN}` : value.trim());

function form() {
  return `
    <form class="card form" data-form="auth">
      <h2>Sign in</h2>
      <label class="field">Email, or the tablet name on a flight deck tablet<input name="email" type="text" required inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" value="${esc(email)}"></label>
      <label class="field">Password<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
      <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : 'Sign in'}</button>
      <button class="btn ghost" type="button" data-act="mode" data-mode="forgot">Forgot your password?</button>
      <p class="tiny">Accounts are made by a team admin: ask one for your email and password, and you choose your own when you first sign in. On a tablet that stays in the cockpit, sign in as <strong>${EFB_LOGINS.join(
        '</strong> or <strong>',
      )}</strong> with the flight deck password.</p>
    </form>`;
}

export function render() {
  return `
    <div class="login">
      <div class="login-brand">
        <img src="icons/icon.svg" alt="" width="72" height="72">
        <h1>QFA100 Ops</h1>
        <div class="tiny">WORLDFLIGHT · 737 OPERATIONS</div>
      </div>
      ${
        !configured
          ? notConnected()
          : mode === 'newpass'
            ? newPassword()
            : mode === 'forgot'
              ? forgot()
              : getSession() && needsSetup()
                ? setup()
                : getSession() && isPending()
                  ? awaitingApproval()
                  : form()
      }
    </div>`;
}

export const forms = {
  // The person's own email and password, replacing what the admin set up. They
  // are signed in again straight away with the new ones, which both proves
  // they work and puts the right address on the session.
  async setup(data) {
    if (busy) return;
    const addr = String(data.get('email')).trim();
    const password = String(data.get('password'));
    if (password !== String(data.get('again'))) {
      error = 'Those two passwords are not the same.';
      return rerender();
    }
    busy = true;
    error = '';
    rerender();
    try {
      await finishSetup(addr, password);
      await signIn(addr, password);
      await syncTeam();
    } catch (err) {
      error = err.message;
    }
    busy = false;
    rerender();
  },

  async auth(data) {
    if (busy) return;
    email = String(data.get('email')).trim();
    const password = String(data.get('password'));
    busy = true;
    error = '';
    notice = '';
    rerender();
    try {
      await signIn(signInAs(email), password);
      await syncTeam();
      // Whoever uses this page next starts from Sign in.
      mode = 'signin';
    } catch (err) {
      error = err.message;
    }
    busy = false;
    // Once signed in, the app shell takes over and shows the Dashboard.
    rerender();
  },
};

async function submit(work) {
  if (busy) return;
  busy = true;
  error = '';
  notice = '';
  rerender();
  try {
    await work();
  } catch (err) {
    error = err.message;
  }
  busy = false;
  rerender();
}

forms.forgot = (data) =>
  submit(async () => {
    email = String(data.get('email')).trim();
    await requestReset(email);
    notice = 'If that email has an account, a reset link is on its way. Open it on this device.';
  });

forms.newpass = (data) =>
  submit(async () => {
    await setPassword(String(data.get('password')));
    mode = 'signin';
    notice = 'Password changed.';
    await syncTeam();
  });

export const actions = {
  async cancelReset() {
    mode = 'signin';
    await signOut();
    clearTeam();
    rerender();
  },
  async recheck() {
    busy = true;
    rerender();
    await syncTeam();
    busy = false;
    rerender();
  },
  async signout() {
    await signOut();
    clearTeam();
    rerender();
  },
  mode(el) {
    mode = el.dataset.mode;
    error = '';
    notice = '';
    rerender();
  },
  preview() {
    state.preview = true;
    save();
    rerender();
  },
};

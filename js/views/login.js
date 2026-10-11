// The first page: sign in or create an account.

import { state, save } from '../store.js';
import { configured, signIn, signUp, signOut, getSession } from '../api.js';
import { esc, icon, rerender } from '../ui.js';
import { syncTeam, clearTeam, isPending, me } from '../ops.js';

let mode = 'signin';
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

function form() {
  const signup = mode === 'signup';
  return `
    <form class="card form" data-form="auth">
      <div class="seg">
        <button type="button" class="${signup ? '' : 'on'}" data-act="mode" data-mode="signin">Sign in</button>
        <button type="button" class="${signup ? 'on' : ''}" data-act="mode" data-mode="signup">Create account</button>
      </div>
      ${
        signup
          ? '<label class="field">Your name (shown on the roster)<input name="name" required maxlength="60" autocomplete="name" placeholder="e.g. Corey Manning"></label>'
          : ''
      }
      <label class="field">Email<input name="email" type="email" required autocomplete="email" autocapitalize="none" value="${esc(email)}"></label>
      <label class="field">Password<input name="password" type="password" required minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
      <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
      ${signup ? '<p class="tiny">Use at least 8 characters. A team admin has to approve your account before you can use the app.</p>' : ''}
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
      ${!configured ? notConnected() : getSession() && isPending() ? awaitingApproval() : form()}
    </div>`;
}

export const forms = {
  async auth(data) {
    if (busy) return;
    email = String(data.get('email')).trim();
    const password = String(data.get('password'));
    busy = true;
    error = '';
    notice = '';
    rerender();
    try {
      if (mode === 'signup') {
        const signedIn = await signUp(email, password, String(data.get('name')).trim());
        if (!signedIn) {
          mode = 'signin';
          notice = 'Account created. Check your email for a confirmation link, then sign in here. A team admin then approves your account.';
        }
      } else {
        await signIn(email, password);
      }
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

export const actions = {
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

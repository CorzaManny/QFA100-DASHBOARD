// The first page: sign in or create an account.

import { state, save } from '../store.js';
import { configured, signIn, signUp } from '../api.js';
import { esc, icon, rerender } from '../ui.js';
import { syncTeam } from '../ops.js';

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
      ${signup ? '<p class="tiny">Use at least 8 characters. A team admin rosters you once your account exists.</p>' : ''}
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
      ${configured ? form() : notConnected()}
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
          notice = 'Account created. Check your email for a confirmation link, then sign in here.';
        }
      } else {
        await signIn(email, password);
      }
      await syncTeam();
    } catch (err) {
      error = err.message;
    }
    busy = false;
    // Once signed in, the app shell takes over and shows the Dashboard.
    rerender();
  },
};

export const actions = {
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

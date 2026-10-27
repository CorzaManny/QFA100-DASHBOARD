import { esc } from '../ui.js';
import { fetchPublicTeam, savePublicTeamMember, deletePublicTeamMember, reorderPublicTeam, uploadTeamPhoto } from '../api.js';

export const teamPage = () => `<section class="card"><h2>Public team</h2>
  <p class="note">Names, roles, photos and descriptions saved here are public. Drag the handle to change the display order, or use the arrow buttons.</p>
  <div id="public-team"><p class="note">Loading team…</p></div></section>`;

export async function mountTeam(root) {
  const host = root.querySelector('#public-team');
  if (!host) return;
  let members = [], busy = false, dragged = null;
  const notice = document.createElement('p');
  notice.className = 'note';
  notice.setAttribute('role', 'status');
  host.before(notice);
  const say = (message) => { notice.textContent = message; };
  const photo = (url) => /^https?:\/\//i.test(url || '') ? `<img class="team-photo" src="${esc(url)}" alt="Team member photo">` : '';
  const draw = () => {
    host.innerHTML = `<div class="team-list">${members.map((m, i) => `<article class="team-member" data-member="${esc(m.id)}">
      <div class="btn-row"><button type="button" class="btn ghost team-handle" draggable="true" aria-label="Drag to reorder ${esc(m.name)}">⠿</button>
      <span class="row-main"><strong>${esc(m.name)}</strong> · ${esc(m.role)}</span>
      <button type="button" class="btn ghost" data-move="-1" aria-label="Move ${esc(m.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn ghost" data-move="1" aria-label="Move ${esc(m.name)} down" ${i === members.length - 1 ? 'disabled' : ''}>↓</button></div>
      ${editor(m)}</article>`).join('')}</div>
      <h3>Add team member</h3>${editor()}`;
  };
  const editor = (m = {}) => `<form class="team-form" data-member-id="${esc(m.id || '')}">
    ${photo(m.photo_url)}
    <label>Name<input name="name" required maxlength="120" value="${esc(m.name || '')}"></label>
    <label>Role<input name="role" required maxlength="120" value="${esc(m.role || '')}" placeholder="Enter public role title"></label>
    <label>Short description<textarea name="description" required maxlength="1000" rows="3">${esc(m.description || '')}</textarea></label>
    <label>${m.photo_url ? 'Replace photo' : 'Photo'}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" ${m.photo_url ? '' : 'required'}></label>
    <p class="tiny">JPEG, PNG or WebP, up to 5 MB.</p>
    <div class="btn-row"><button class="btn primary" type="submit">${m.id ? 'Save changes' : 'Add member'}</button>
    ${m.id ? '<button class="btn danger" type="button" data-delete>Delete member</button>' : ''}</div></form>`;
  const run = async (work, success) => {
    if (busy) return;
    busy = true;
    host.inert = true;
    try {
      await work();
      members = await fetchPublicTeam();
      draw();
      say(success);
    } catch (err) { say(err.message); }
    finally { busy = false; host.inert = false; }
  };
  host.addEventListener('submit', (event) => {
    const form = event.target.closest('.team-form');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form), memberId = form.dataset.memberId;
    const fields = Object.fromEntries(['name', 'role', 'description'].map((key) => [key, String(data.get(key) || '').trim()]));
    if (Object.values(fields).some((value) => !value)) return say('Enter a name, role and short description.');
    const file = data.get('photo');
    run(async () => {
      if (file?.size) fields.photo_url = await uploadTeamPhoto(file);
      if (!memberId) {
        if (!fields.photo_url) throw new Error('Choose a photo.');
        fields.position = Math.max(-1, ...members.map((m) => m.position)) + 1;
      }
      await savePublicTeamMember(fields, memberId);
    }, 'Team member saved.');
  });
  const move = (from, to) => {
    if (from < 0 || to < 0 || to >= members.length || from === to) return;
    const ordered = [...members];
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    run(() => reorderPublicTeam(ordered.map((m) => m.id)), 'Team order saved.');
  };
  host.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    const card = button?.closest('[data-member]');
    if (!card) return;
    if (button.hasAttribute('data-delete') && confirm('Delete this public team member?'))
      run(() => deletePublicTeamMember(card.dataset.member), 'Team member deleted.');
    if (button.dataset.move) {
      const index = members.findIndex((m) => m.id === card.dataset.member);
      move(index, index + Number(button.dataset.move));
    }
  });
  host.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.team-handle');
    if (!handle || busy) return event.preventDefault();
    dragged = handle.closest('[data-member]').dataset.member;
    event.dataTransfer.setData('text/plain', dragged);
    event.dataTransfer.effectAllowed = 'move';
  });
  host.addEventListener('dragover', (event) => {
    if (dragged && event.target.closest('[data-member]')) event.preventDefault();
  });
  host.addEventListener('drop', (event) => {
    const card = event.target.closest('[data-member]');
    if (!dragged || !card) return;
    event.preventDefault();
    move(members.findIndex((m) => m.id === dragged), members.findIndex((m) => m.id === card.dataset.member));
    dragged = null;
  });
  host.addEventListener('dragend', () => { dragged = null; });
  try { members = await fetchPublicTeam(); draw(); }
  catch (err) { host.textContent = 'Unable to load the team. Check that supabase/team.sql has been applied, then reopen this tab.'; say(err.message); }
}

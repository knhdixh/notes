import { createEditor } from '/vendor/editor.js';
import { wordCount, localDay, addDays, DAY_CUTOFF_HOUR } from '/lib.js';

const $ = (id) => document.getElementById(id);
const $toast = $('toast');
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = matchMedia('(max-width: 760px)');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(path, { method = 'GET', body, keepalive } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, keepalive,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Offline, or the Access session expired (its login redirect is cross-origin).
    throw new Error(navigator.onLine ? 'Connection lost. Text is kept on this device; reload to sign in again.' : 'Offline. Retrying.');
  }
  // Cloudflare Access session expired: it answers with a login redirect, not JSON.
  if (res.redirected || res.status === 401) {
    location.reload();
    throw new Error('Signed out.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
export function toast(msg, isError = false) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isError ? ' error' : '');
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), isError ? 6000 : 3000);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('notes:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('notes:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('notes:' + k); } catch { /* ignore */ } },
};

/* ---------- autosave with retry and a local safety copy ---------- */
// Each pending save remembers which note/day it belongs to, so a retry can never land on another one.
function createSaver(ctx, save, onState) {
  let timer, pending = null, inflight = false, retry, warned = false;
  async function run() {
    clearTimeout(timer);
    if (inflight || pending == null) return;
    const job = pending;
    pending = null; inflight = true;
    onState('saving');
    try {
      await save(job.text, job.key);
      inflight = false; warned = false;
      if (pending == null) { store.del('draft:' + job.key); onState('saved'); } else run();
    } catch (e) {
      inflight = false;
      if (pending == null) pending = job;
      onState('offline');
      clearTimeout(retry);
      retry = setTimeout(run, 5000);
      if (!warned && !/Offline|Signed out/.test(e.message)) { warned = true; toast(e.message, true); }
    }
  }
  return {
    push(text) {
      const key = ctx();
      // A failed save for another note stays in its local draft and is restored when reopened.
      pending = { text, key };
      store.set('draft:' + key, text);
      onState('edited');
      clearTimeout(timer);
      timer = setTimeout(run, 700);
    },
    flush: run,
    get dirty() { return pending != null || inflight; },
    beacon(url) {
      if (pending == null) return;
      fetch(url(pending.key), { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: pending.text }) });
    },
  };
}
const stateLabel = { saving: 'Saving', saved: 'Saved', edited: '', offline: 'Offline · kept locally' };

/* ---------- formatting ---------- */
const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
};
const fmtDay = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const n = (x) => Number(x || 0).toLocaleString('en-GB');
const plural = (x, w) => `${n(x)} ${w}${x === 1 ? '' : 's'}`;

/* ---------- state ---------- */
const S = {
  view: 'diary', tag: null, q: '', notes: [], tags: [], noteId: null, note: null,
  diary: null, day: null, calMonth: null,
  opts: store.get('opts', { focus: false, typewriter: false }),
};

/* ---------- editors ---------- */
const noteSaver = createSaver(() => S.noteId, async (body, id) => {
  const saved = await api(`/api/notes/${id}`, { method: 'PUT', body: { body } });
  const row = S.notes.find((x) => x.id === id);
  if (row) { Object.assign(row, saved, { body: undefined }); renderRows(); }
  if (S.note && S.note.id === id) S.note.tags = saved.tags;
  if (saved.tags.join() !== (S.lastTags || '')) { S.lastTags = saved.tags.join(); loadTags(); }
}, (st) => { $('note-status').textContent = stateLabel[st]; });

const diarySaver = createSaver(() => 'day:' + S.day, async (body, key) => {
  const day = key.slice(4);
  const before = S.diary.stats;
  const r = await api(`/api/diary/${day}?tz=${encodeURIComponent(TZ)}`, { method: 'PUT', body: { body } });
  S.diary = { ...S.diary, today: r.today, days: r.days, stats: r.stats, entry: r.entry.day === r.today ? r.entry : S.diary.entry };
  if (r.today === day && r.stats.todayDone && !before.todayDone) {
    toast(`${n(r.stats.goal)} words. ${plural(r.stats.current, 'day')} in a row.`);
  }
  renderRail();
}, (st) => { $('diary-status').textContent = stateLabel[st]; });

const noteEd = createEditor({
  parent: $('note-editor'),
  placeholder: 'Start with a title…',
  title: true,
  onChange(text) {
    $('note-words').textContent = plural(wordCount(text), 'word');
    noteSaver.push(text);
  },
  onTag: (tag) => go(`#/tag/${encodeURIComponent(tag)}`),
});
const diaryEd = createEditor({
  parent: $('diary-editor'),
  placeholder: 'Just write. Whatever is on your mind.',
  onChange(text) { diarySaver.push(text); renderDiaryCount(wordCount(text)); },
});
for (const ed of [noteEd, diaryEd]) ed.setOptions(S.opts);

/* ---------- routing ---------- */
// #/today · #/day/2026-10-01 · #/notes[/id] · #/tag/<tag>[/id] · #/trash[/id]
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (parts[0]) {
    case 'day': return { view: 'diary', day: parts[1] };
    case 'notes': return { view: 'notes', id: parts[1] };
    case 'trash': return { view: 'trash', id: parts[1] };
    case 'tag': {
      const last = parts[parts.length - 1];
      const isId = /^[0-9a-f-]{36}$/.test(last);
      return { view: 'tag', tag: parts.slice(1, isId ? -1 : undefined).join('/'), id: isId ? last : undefined };
    }
    case 'menu': return { view: 'menu' };
    default: return { view: 'diary' };
  }
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
const listHash = () => (S.view === 'tag' ? `#/tag/${S.tag.split('/').map(encodeURIComponent).join('/')}` : `#/${S.view}`);

async function route() {
  const r = parseHash();
  if (r.view === 'menu') { setScreen('nav'); return; }
  await leaveNote();
  if (r.view === 'diary') {
    S.view = 'diary';
    document.body.dataset.view = 'diary';
    setScreen('diary');
    markNav();
    await openDay(r.day);
    return;
  }
  const listChanged = S.view !== r.view || S.tag !== (r.tag || null) || !S.listLoaded;
  S.view = r.view; S.tag = r.tag || null;
  document.body.dataset.view = 'notes';
  markNav();
  if (listChanged) await loadNotes(true);
  if (r.id) { await openNote(r.id); setScreen('note'); }
  else {
    S.noteId = null; S.note = null;
    $('note-pane').hidden = true;
    $('empty-pane').hidden = false;
    renderRows();
    setScreen('list');
  }
}

function setScreen(s) { document.body.dataset.screen = s; }

function markNav() {
  document.querySelectorAll('.nav-row').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  document.querySelectorAll('.tag-row').forEach((b) => b.classList.toggle('on', S.view === 'tag' && b.dataset.tag === S.tag));
  $('diary-pane').hidden = S.view !== 'diary';
  $('empty-pane').hidden = S.view === 'diary' || !!S.noteId;
}

/* ---------- notes ---------- */
async function loadNotes(intro = false) {
  const p = new URLSearchParams();
  if (S.view === 'trash') p.set('trash', '1');
  if (S.view === 'tag') p.set('tag', S.tag);
  if (S.q) p.set('q', S.q);
  S.notes = await api('/api/notes?' + p);
  S.listLoaded = true;
  $('list-title').textContent = S.view === 'tag' ? '#' + S.tag : S.view;
  $('list-label').textContent = S.q ? 'Results' : S.view === 'trash' ? 'Deleted' : 'Recent';
  $('empty-trash').hidden = S.view !== 'trash' || !S.notes.length;
  renderRows(intro && !reduced);
}

function renderRows(intro = false) {
  const ul = $('rows');
  ul.classList.toggle('intro', intro);
  $('list-n').textContent = S.notes.length ? String(S.notes.length).padStart(2, '0') : '';
  if (S.view === 'notes' && !S.q) $('nav-count').textContent = S.notes.length || '';
  if (!S.notes.length) {
    ul.innerHTML = `<li class="empty">${S.q ? 'Nothing matches.' : S.view === 'trash' ? 'Trash is empty.' : 'No notes yet.'}</li>`;
    return;
  }
  ul.innerHTML = S.notes.map((x, i) => `
    <li style="--i:${Math.min(i, 12)}"><a class="row${x.id === S.noteId ? ' on' : ''}" href="${listHash()}/${x.id}">
      <span class="row-title">${esc(x.title || 'Untitled')}</span>
      <span class="row-date">${x.pinned ? 'pinned · ' : ''}${fmtDate(S.view === 'trash' ? x.trashed_at : x.updated_at)}</span>
      ${x.snippet ? `<span class="row-snip">${esc(x.snippet)}</span>` : ''}
    </a></li>`).join('');
}

async function loadTags() {
  S.tags = await api('/api/tags');
  // Show parents of nested tags even when only children are used.
  const all = new Map();
  for (const t of S.tags) {
    const parts = t.tag.split('/');
    for (let i = 1; i < parts.length; i++) { const p = parts.slice(0, i).join('/'); if (!all.has(p)) all.set(p, 0); }
    all.set(t.tag, t.count);
  }
  const list = [...all.keys()].sort();
  $('tag-count').textContent = list.length ? String(list.length).padStart(2, '0') : '';
  $('tags').innerHTML = list.length ? list.map((tag) => {
    const parts = tag.split('/');
    return `<li><a class="tag-row${S.view === 'tag' && S.tag === tag ? ' on' : ''}" data-tag="${esc(tag)}" style="--depth:${parts.length - 1}" href="#/tag/${parts.map(encodeURIComponent).join('/')}">
      <span class="tag-name">${esc(parts[parts.length - 1])}</span><span class="nav-n">${all.get(tag) || ''}</span></a></li>`;
  }).join('') : '<li class="muted" style="font-size:13px">Type #tag in a note.</li>';
}

async function openNote(id) {
  if (S.noteId === id && S.note) return;
  const note = await api(`/api/notes/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!note) { go(listHash()); return; }
  S.noteId = id; S.note = note; S.lastTags = note.tags.join();
  const draft = store.get('draft:' + id, null);
  const body = draft != null && draft !== note.body ? draft : note.body;
  noteEd.setDoc(body);
  if (draft != null && draft !== note.body) noteSaver.push(draft);
  $('note-pane').hidden = false;
  $('empty-pane').hidden = true;
  $('note-words').textContent = plural(wordCount(body), 'word');
  $('note-status').textContent = '';
  const trashed = !!note.trashed_at;
  $('trash-banner').hidden = !trashed;
  $('pin').hidden = $('trash-note').hidden = trashed;
  $('pin').textContent = note.pinned ? 'unpin' : 'pin';
  noteEd.view.contentDOM.contentEditable = String(!trashed);
  renderRows();
  if (!narrow.matches || !body) noteEd.focus();
}

// Leaving a note: save it, and drop it if it was never written in.
async function leaveNote() {
  if (!S.noteId) return;
  await noteSaver.flush();
  const id = S.noteId;
  const text = noteEd.getDoc();
  if (!text.replace(/#[\p{L}\p{N}_/-]+/gu, '').trim() && S.note && !S.note.trashed_at) {
    await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: true } }).catch(() => {});
    await api(`/api/notes/${id}`, { method: 'DELETE' }).catch(() => {});
    S.notes = S.notes.filter((x) => x.id !== id);
    store.del('draft:' + id);
  }
  S.noteId = null; S.note = null;
}

async function newNote() {
  if (S.view === 'trash' || S.view === 'diary') { S.view = 'notes'; S.tag = null; }
  const body = S.view === 'tag' ? `\n\n#${S.tag}` : '';
  const note = await api('/api/notes', { method: 'POST', body: { body } });
  if (S.q) { S.q = ''; $('search').value = ''; }
  S.notes.unshift({ ...note, body: undefined });
  go(`${listHash()}/${note.id}`);
  requestAnimationFrame(() => { noteEd.view.dispatch({ selection: { anchor: 0 } }); noteEd.focus(); });
}

/* ---------- diary ---------- */
async function loadDiary() {
  const d = await api(`/api/diary?tz=${encodeURIComponent(TZ)}`);
  S.diary = d;
  if (!S.calMonth) S.calMonth = d.today.slice(0, 7);
  return d;
}

async function openDay(day) {
  if (diarySaver.dirty) await diarySaver.flush();
  const d = S.diary && Date.now() - (S.diaryAt || 0) < 30e3 ? S.diary : await loadDiary();
  S.diaryAt = Date.now();
  const target = day && day <= d.today ? day : d.today;
  const changed = S.day !== target;
  S.day = target;
  const entry = target === d.today && d.entry && d.entry.day === target ? d.entry : await api(`/api/diary/${target}`);
  const draft = store.get('draft:day:' + target, null);
  const body = draft != null && draft !== entry.body ? draft : entry.body;
  if (changed || diaryEd.getDoc() !== body) diaryEd.setDoc(body, { cursorEnd: true });
  if (draft != null && draft !== entry.body) diarySaver.push(draft);
  if (changed) renderTitle(target);
  $('past-note').hidden = target === d.today;
  $('diary-status').textContent = '';
  renderDiaryCount(wordCount(body));
  renderRail();
  if (!narrow.matches) diaryEd.focus();
}

function renderTitle(day) {
  const h = $('diary-title');
  const words = fmtDay(day).split(' ');
  h.setAttribute('aria-label', fmtDay(day));
  h.innerHTML = words.map((w, i) => `<span class="mask"><span class="w" style="--i:${i}">${esc(w)}</span></span>`).join(' ');
}

function renderDiaryCount(words) {
  const goal = S.diary ? S.diary.stats.goal : 750;
  const isToday = S.diary && S.day === S.diary.today;
  $('diary-words').textContent = plural(words, 'word');
  $('diary-togo').textContent = !isToday ? '' : words >= goal ? 'done' : `${n(goal - words)} to go`;
  $('progress').style.transform = `scaleX(${Math.min(1, words / goal)})`;
}

function hoursLeft() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const h = +parts.find((p) => p.type === 'hour').value, m = +parts.find((p) => p.type === 'minute').value;
  return ((24 + DAY_CUTOFF_HOUR - h) % 24 || 24) - m / 60;
}

function renderRail() {
  const { stats, today } = S.diary;
  $('streak').textContent = n(stats.current);
  $('streak-label').textContent = stats.current === 1 ? 'day streak' : 'day streak';
  $('nav-streak').textContent = stats.current ? n(stats.current) + (stats.todayDone ? '' : ' ·') : '';
  $('nav-streak').title = stats.todayDone ? 'Done today' : 'Not done today';
  let hint;
  if (stats.todayDone) hint = 'Done for today.';
  else if (stats.current > 0) {
    const left = hoursLeft();
    hint = `${n(stats.toGo)} words to keep it going` + (left < 6 ? ` · ${Math.max(1, Math.round(left))}h left.` : '.');
  } else hint = `Write ${n(stats.goal)} words to start.`;
  $('streak-hint').textContent = hint;
  $('freezes').textContent = stats.freezes + (stats.nextFreezeIn ? ` · next in ${stats.nextFreezeIn}` : '');
  $('freezes').parentElement.title = 'Every 7 completed days earns a freeze (max 2). A freeze covers one missed day.';
  $('longest').textContent = n(stats.longest);
  $('done-days').textContent = n(stats.completedDays);
  $('total-words').textContent = n(stats.totalWords);
  if (!$('goal').querySelector('input')) $('goal').textContent = n(stats.goal);
  renderCal(today, stats.status);
}

function renderCal(today, status) {
  const [y, m] = S.calMonth.split('-').map(Number);
  const first = `${S.calMonth}-01`;
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
  $('cal-title').textContent = new Date(first + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('cal-next').disabled = S.calMonth >= today.slice(0, 7);
  $('cal-next').style.visibility = $('cal-next').disabled ? 'hidden' : '';
  const words = new Map(S.diary.days.map((d) => [d.day, d.words]));
  let html = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span class="dow">${d}</span>`).join('');
  html += '<span class="d blank"></span>'.repeat(lead);
  for (let i = 0; i < daysIn; i++) {
    const day = addDays(first, i);
    const st = status[day] || (words.get(day) ? 'partial' : '');
    const cls = ['d', st, day === today ? 'today' : '', day === S.day ? 'sel' : '', day > today ? 'future' : ''].join(' ');
    const label = `${fmtDay(day)}: ${words.get(day) ? plural(words.get(day), 'word') : 'nothing'}${st === 'frozen' ? ', frozen' : st === 'done' ? ', done' : ''}`;
    html += day > today
      ? `<span class="${cls}" aria-hidden="true"></span>`
      : `<a class="${cls}" href="#/day/${day}" title="${esc(label)}" aria-label="${esc(label)}"></a>`;
  }
  $('cal').innerHTML = html;
}

function shiftMonth(delta) {
  const [y, m] = S.calMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  S.calMonth = d.toISOString().slice(0, 7);
  renderCal(S.diary.today, S.diary.stats.status);
}

/* ---------- toggles ---------- */
function applyToggles() {
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    const k = b.dataset.toggle;
    b.classList.toggle('on', k === 'full' ? document.body.classList.contains('full') : !!S.opts[k]);
  });
}
function toggle(k) {
  if (k === 'full') document.body.classList.toggle('full');
  else {
    S.opts[k] = !S.opts[k];
    store.set('opts', S.opts);
    for (const ed of [noteEd, diaryEd]) ed.setOptions(S.opts);
  }
  applyToggles();
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle],[data-back],[data-view]');
  if (!t) return;
  if (t.dataset.toggle) toggle(t.dataset.toggle);
  else if (t.dataset.back === 'nav') go('#/menu');
  else if (t.dataset.back === 'list') go(listHash());
  else if (t.dataset.view) go(t.dataset.view === 'diary' ? '#/today' : `#/${t.dataset.view}`);
});
$('new-note').addEventListener('click', () => newNote().catch((e) => toast(e.message, true)));
$('back-today').addEventListener('click', () => go('#/today'));
$('cal-prev').addEventListener('click', () => shiftMonth(-1));
$('cal-next').addEventListener('click', () => shiftMonth(1));

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.q = e.target.value.trim(); loadNotes().catch((err) => toast(err.message, true)); }, 200);
});

$('pin').addEventListener('click', async () => {
  const note = await api(`/api/notes/${S.noteId}`, { method: 'PUT', body: { pinned: !S.note.pinned } });
  S.note.pinned = note.pinned;
  $('pin').textContent = note.pinned ? 'unpin' : 'pin';
  await loadNotes();
});
$('trash-note').addEventListener('click', async () => {
  await noteSaver.flush();
  const id = S.noteId;
  await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: true } });
  S.note = null; S.noteId = null;
  toast('Moved to trash.');
  S.notes = S.notes.filter((x) => x.id !== id);
  go(listHash());
  loadTags();
});
$('restore').addEventListener('click', async () => {
  const id = S.noteId;
  await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: false } });
  S.note = null; S.noteId = null;
  toast('Restored.');
  go(`#/notes/${id}`);
  loadTags();
});
$('purge').addEventListener('click', async () => {
  if (!confirm('Delete this note forever?')) return;
  await api(`/api/notes/${S.noteId}`, { method: 'DELETE' });
  S.note = null; S.noteId = null;
  await loadNotes();
  go('#/trash');
});
$('empty-trash').addEventListener('click', async () => {
  if (!confirm(`Delete ${plural(S.notes.length, 'note')} forever?`)) return;
  await api('/api/trash', { method: 'DELETE' });
  await loadNotes();
});

$('goal').addEventListener('click', () => {
  const btn = $('goal');
  if (btn.querySelector('input')) return;
  btn.innerHTML = `<input class="field goal-input" type="number" min="50" max="10000" step="50" value="${S.diary.stats.goal}" aria-label="Daily goal">`;
  const input = btn.querySelector('input');
  input.focus(); input.select();
  const done = async (save) => {
    const v = Number(input.value);
    btn.textContent = n(S.diary.stats.goal);
    if (!save || v === S.diary.stats.goal) return;
    try {
      await api('/api/settings', { method: 'PUT', body: { goal: v } });
      S.diaryAt = 0;
      await loadDiary();
      renderRail();
      renderDiaryCount(wordCount(diaryEd.getDoc()));
      toast(`Goal: ${n(v)} words.`);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.dataset.cancel = 1; input.blur(); } });
  input.addEventListener('blur', () => done(!input.dataset.cancel), { once: true });
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === '.') { e.preventDefault(); toggle('full'); }
  else if (e.key === 'Escape' && document.body.classList.contains('full')) toggle('full');
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.view === 'diary') go('#/notes'); setTimeout(() => $('search').focus(), 50); }
  else if (mod && e.altKey && e.code === 'KeyN') { e.preventDefault(); newNote(); }
  else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); go('#/today'); }
});

addEventListener('hashchange', () => route().catch((e) => toast(e.message, true)));
addEventListener('pagehide', () => {
  noteSaver.beacon((id) => `/api/notes/${id}`);
  diarySaver.beacon((key) => `/api/diary/${key.slice(4)}?tz=${encodeURIComponent(TZ)}`);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { noteSaver.flush(); diarySaver.flush(); }
  else checkRollover();
});

// The diary day changes at 3 a.m.; move to the new page if nothing is pending.
function checkRollover() {
  if (!S.diary || S.view !== 'diary' || diarySaver.dirty) return;
  if (localDay(Date.now(), TZ) !== S.diary.today && S.day === S.diary.today) {
    S.diaryAt = 0; S.day = null; S.diary = null; S.calMonth = null;
    route();
  }
}
setInterval(checkRollover, 60e3);

/* ---------- boot ---------- */
(async function boot() {
  applyToggles();
  api('/api/me').then((m) => { $('me').textContent = m.email; }).catch(() => {});
  if (!location.hash) history.replaceState(null, '', '#/today');
  await Promise.all([loadTags(), loadDiary()]);
  await route();
  if (!S.listLoaded) api('/api/notes').then((x) => { $('nav-count').textContent = x.length || ''; });
})().catch((err) => toast(err.message, true));

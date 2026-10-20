import { createEditor } from '/vendor/editor.js';
import { wordCount, localDay, addDays, DAY_CUTOFF_HOUR } from '/lib.js';
import { $, api, esc, toast, store, n, plural, fmtDate, fmtDay, fuzzy } from '/ui.js';
import { createSync } from '/sync.js';
import { insertFiles, isImage } from '/uploads.js';
import { files, loadFiles, renderFiles, bindFilesView, openViewer, closeViewer, uploadToLibrary } from '/files-view.js';
import { createPalette } from '/palette.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = matchMedia('(max-width: 760px)');
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl ';

/* ---------- state ---------- */
const S = {
  view: 'diary', tag: null, q: '', notes: [], tags: [], noteId: null, note: null,
  diary: null, day: null, calMonth: null,
  opts: store.get('opts', { focus: false, typewriter: false }),
};
const stateLabel = { saving: 'Saving', saved: 'Saved', merged: 'Merged with another device', edited: '', offline: 'Offline · kept locally' };

/* ---------- editors ---------- */
const noteEd = createEditor({
  parent: $('note-editor'),
  placeholder: 'Start with a title…',
  title: true,
  onChange(text) {
    $('note-words').textContent = plural(wordCount(text), 'word');
    noteSync.push(text);
  },
  onTag: (tag) => go(`#/tag/${encodeURIComponent(tag)}`),
  onFiles: (list, pos) => insertFiles(noteEd, list, pos).then(refreshFilesIfShown),
});
const diaryEd = createEditor({
  parent: $('diary-editor'),
  placeholder: 'Just write. Whatever is on your mind.',
  onChange(text) { diarySync.push(text); renderDiaryCount(wordCount(text)); },
  onFiles: (list, pos) => insertFiles(diaryEd, list, pos).then(refreshFilesIfShown),
});
for (const ed of [noteEd, diaryEd]) ed.setOptions(S.opts);

/* ---------- sync (autosave + two-device merge) ---------- */
const noteSync = createSync({
  ctx: () => S.noteId,
  url: (id) => `/api/notes/${id}`,
  current: (id) => (S.noteId === id ? noteEd.getDoc() : null),
  apply(id, text) {
    if (S.noteId !== id) return;
    noteEd.applyRemote(text);
    $('note-words').textContent = plural(wordCount(text), 'word');
  },
  docOf: (r) => r.note || r,
  onSaved(id, saved) {
    const row = S.notes.find((x) => x.id === id);
    if (row) { Object.assign(row, saved, { body: undefined }); renderRows(); }
    if (S.note && S.note.id === id) S.note.tags = saved.tags;
    if (saved.tags.join() !== (S.lastTags || '')) { S.lastTags = saved.tags.join(); loadTags(); }
  },
  onState: (st) => { $('note-status').textContent = stateLabel[st]; },
});

const diarySync = createSync({
  ctx: () => (S.day ? 'day:' + S.day : null),
  url: (key) => `/api/diary/${key.slice(4)}?tz=${encodeURIComponent(TZ)}`,
  current: (key) => (S.day && 'day:' + S.day === key ? diaryEd.getDoc() : null),
  apply(key, text) {
    if ('day:' + S.day !== key) return;
    diaryEd.applyRemote(text);
    renderDiaryCount(wordCount(text));
  },
  docOf: (r) => r.entry,
  onSaved(key, r) {
    const before = S.diary.stats;
    S.diary = { ...S.diary, today: r.today, days: r.days, stats: r.stats };
    if (r.today === key.slice(4) && r.stats.todayDone && !before.todayDone) {
      toast(`${n(r.stats.goal)} words. ${plural(r.stats.current, 'day')} in a row.`);
    }
    renderRail();
  },
  onState: (st) => { $('diary-status').textContent = stateLabel[st]; },
});

/* ---------- routing ---------- */
// #/today · #/day/2026-10-01 · #/notes[/id] · #/tag/<tag>[/id] · #/trash[/id] · #/files
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (parts[0]) {
    case 'day': return { view: 'diary', day: parts[1] };
    case 'notes': return { view: 'notes', id: parts[1] };
    case 'trash': return { view: 'trash', id: parts[1] };
    case 'files': return { view: 'files' };
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
const listHash = () => (S.view === 'tag' ? `#/tag/${S.tag.split('/').map(encodeURIComponent).join('/')}` : S.view === 'trash' ? '#/trash' : '#/notes');

async function route() {
  const r = parseHash();
  if (r.view === 'menu') { setScreen('nav'); return; }
  await leaveNote();
  if (r.view === 'diary' || r.view === 'files') {
    S.view = r.view;
    document.body.dataset.view = r.view;
    setScreen(r.view);
    markNav();
    if (r.view === 'diary') await openDay(r.day);
    else {
      if (S.day) await diarySync.flush();
      renderFiles();
      await loadFiles();
      renderFiles();
    }
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
  $('files-pane').hidden = S.view !== 'files';
  $('note-pane').hidden = S.view === 'diary' || S.view === 'files' || !S.noteId;
  $('empty-pane').hidden = S.view === 'diary' || S.view === 'files' || !!S.noteId;
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
  S.tagList = [...all.keys()].sort();
  $('tag-count').textContent = S.tagList.length ? String(S.tagList.length).padStart(2, '0') : '';
  $('tags').innerHTML = S.tagList.length ? S.tagList.map((tag) => {
    const parts = tag.split('/');
    return `<li><a class="tag-row${S.view === 'tag' && S.tag === tag ? ' on' : ''}" data-tag="${esc(tag)}" style="--depth:${parts.length - 1}" href="${tagHash(tag)}">
      <span class="tag-name">${esc(parts[parts.length - 1])}</span><span class="nav-n">${all.get(tag) || ''}</span></a></li>`;
  }).join('') : '<li class="muted" style="font-size:13px">Type #tag in a note.</li>';
}
const tagHash = (tag) => `#/tag/${tag.split('/').map(encodeURIComponent).join('/')}`;

async function openNote(id) {
  if (S.noteId === id && S.note) return;
  const note = await api(`/api/notes/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!note) { go(listHash()); return; }
  S.noteId = id; S.note = note; S.lastTags = note.tags.join();
  const { text, dirty } = noteSync.open(id, note);
  noteEd.setDoc(text);
  if (dirty) noteSync.push(text);
  $('note-pane').hidden = false;
  $('empty-pane').hidden = true;
  $('note-words').textContent = plural(wordCount(text), 'word');
  $('note-status').textContent = '';
  const trashed = !!note.trashed_at;
  $('trash-banner').hidden = !trashed;
  $('pin').hidden = $('trash-note').hidden = trashed;
  $('pin').textContent = note.pinned ? 'unpin' : 'pin';
  noteEd.view.contentDOM.contentEditable = String(!trashed);
  renderRows();
  if (!narrow.matches || !text) noteEd.focus();
}

// Leaving a note: save it, and drop it if it was never written in.
async function leaveNote() {
  if (!S.noteId) return;
  await noteSync.flush();
  const id = S.noteId;
  const text = noteEd.getDoc();
  if (!text.replace(/#[\p{L}\p{N}_/-]+/gu, '').trim() && S.note && !S.note.trashed_at && !noteSync.dirty) {
    await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: true } }).catch(() => {});
    await api(`/api/notes/${id}`, { method: 'DELETE' }).catch(() => {});
    S.notes = S.notes.filter((x) => x.id !== id);
    store.del('draft:' + id);
  }
  S.noteId = null; S.note = null;
}

async function newNote() {
  if (!['notes', 'tag'].includes(S.view)) { S.view = 'notes'; S.tag = null; S.listLoaded = false; }
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
  S.diaryAt = Date.now();
  if (!S.calMonth) S.calMonth = d.today.slice(0, 7);
  return d;
}

async function openDay(day) {
  if (diarySync.dirty) await diarySync.flush();
  const d = S.diary && Date.now() - (S.diaryAt || 0) < 30e3 ? S.diary : await loadDiary();
  const target = day && day <= d.today ? day : d.today;
  const entry = await api(`/api/diary/${target}`);
  const changed = S.day !== target;
  S.day = target;
  const { text, dirty } = diarySync.open('day:' + target, entry);
  if (changed || diaryEd.getDoc() !== text) diaryEd.setDoc(text, { cursorEnd: true });
  if (dirty) diarySync.push(text);
  if (changed) renderTitle(target);
  $('past-note').hidden = target === d.today;
  $('diary-status').textContent = '';
  renderDiaryCount(wordCount(text));
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

/* ---------- files ---------- */
const activeEditor = () => (S.view === 'diary' && S.day ? diaryEd : S.noteId && !S.note?.trashed_at && S.view !== 'files' ? noteEd : null);

function refreshFilesIfShown() {
  if (S.view === 'files') loadFiles().then(renderFiles);
  else files.loaded = false;
}

// Upload from the picker or a drop outside an editor: into the open note/day, else the library.
function addFiles(list) {
  const arr = [...list];
  if (!arr.length) return;
  const ed = activeEditor();
  if (ed) insertFiles(ed, arr, ed.cursor).then(refreshFilesIfShown);
  else uploadToLibrary(arr);
}

function pickFiles() { $('file-input').click(); }
$('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

// Drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  dragDepth = 0; $('drop').hidden = true;
  // Drops onto the text itself are placed at the drop point by the editor.
  if (!hasFiles(e) || e.target.closest?.('.cm-editor')) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});

/* ---------- command palette (⌘/) ---------- */
let allNotes = null, allNotesAt = 0;
async function notesIndex() {
  if (!allNotes || Date.now() - allNotesAt > 20e3) {
    allNotes = await api('/api/notes');
    allNotesAt = Date.now();
  }
  return allNotes;
}

function commands() {
  const noteOpen = S.noteId && S.note && S.view !== 'diary' && S.view !== 'files';
  const editing = !!activeEditor();
  return [
    { label: 'New note', hint: `${MOD}⌥N`, run: () => newNote() },
    { label: 'Go to today', hint: `${MOD}J`, run: () => go('#/today') },
    { label: 'Go to notes', run: () => go('#/notes') },
    { label: 'Go to files', run: () => go('#/files') },
    { label: 'Go to trash', run: () => go('#/trash') },
    { label: "Yesterday's entry", run: () => go(`#/day/${addDays(S.diary?.today || localDay(Date.now(), TZ), -1)}`) },
    { label: 'Search notes', hint: `${MOD}K`, run: () => focusSearch() },
    { label: editing ? 'Insert image or file' : 'Upload files', run: pickFiles },
    { label: `${S.opts.focus ? 'Turn off' : 'Turn on'} focus mode`, run: () => toggle('focus') },
    { label: `${S.opts.typewriter ? 'Turn off' : 'Turn on'} typewriter mode`, run: () => toggle('typewriter') },
    { label: document.body.classList.contains('full') ? 'Exit full screen' : 'Full screen', hint: `${MOD}.`, run: () => toggle('full') },
    noteOpen && !S.note.trashed_at && { label: S.note.pinned ? 'Unpin note' : 'Pin note', run: () => $('pin').click() },
    noteOpen && !S.note.trashed_at && { label: 'Move note to trash', run: () => $('trash-note').click() },
    noteOpen && S.note.trashed_at && { label: 'Restore note', run: () => $('restore').click() },
    { label: 'Set daily goal', run: async () => { if (S.view !== 'diary') await new Promise((r) => { go('#/today'); setTimeout(r, 300); }); $('goal').click(); } },
    { label: 'Export everything', run: () => { location.href = '/api/export'; } },
  ].filter(Boolean);
}

const palette = createPalette(async (query) => {
  const q = query.trim();
  const rank = (arr, text, limit) => arr.map((x) => ({ x, s: fuzzy(q, text(x)) })).filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s).slice(0, limit).map((r) => r.x);

  // "#tag" narrows to tags, like Todoist's filters.
  if (q.startsWith('#')) {
    const tq = q.slice(1);
    return [{ title: 'Tags', items: (S.tagList || []).map((t) => ({ t, s: fuzzy(tq, t) })).filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).slice(0, 12)
      .map(({ t }) => ({ label: '#' + t, run: () => go(tagHash(t)) })) }];
  }

  const notes = await notesIndex().catch(() => []);
  if (!q) {
    return [
      { title: 'Recent notes', items: notes.slice(0, 5).map((x) => ({ label: x.title || 'Untitled', meta: fmtDate(x.updated_at), run: () => go(`#/notes/${x.id}`) })) },
      { title: 'Commands', items: commands() },
    ];
  }

  let noteHits = rank(notes, (x) => x.title || 'Untitled', 6);
  // Words inside notes, not only titles.
  if (q.length >= 3 && noteHits.length < 6) {
    const body = await api('/api/notes?q=' + encodeURIComponent(q)).catch(() => []);
    for (const x of body) if (noteHits.length < 8 && !noteHits.some((h) => h.id === x.id)) noteHits.push(x);
  }
  if (!files.loaded) await loadFiles().catch(() => {});
  return [
    { title: 'Commands', items: rank(commands(), (c) => c.label, 6) },
    { title: 'Notes', items: noteHits.map((x) => ({ label: x.title || 'Untitled', meta: fmtDate(x.updated_at), run: () => go(`#/notes/${x.id}`) })) },
    { title: 'Tags', items: rank(S.tagList || [], (t) => t, 4).map((t) => ({ label: '#' + t, run: () => go(tagHash(t)) })) },
    { title: 'Files', items: rank(files.list, (f) => f.name, 4).map((f) => ({ label: f.name, meta: isImage(f.type) ? 'image' : 'file', run: () => openViewer(f) })) },
    { title: 'Diary', items: rank(S.diary?.days || [], (d) => `${fmtDay(d.day)} ${d.day}`, 3).map((d) => ({ label: fmtDay(d.day), meta: plural(d.words, 'word'), run: () => go(`#/day/${d.day}`) })) },
  ];
});

function focusSearch() {
  if (!['notes', 'tag', 'trash'].includes(S.view)) go('#/notes');
  setTimeout(() => $('search').focus(), 60);
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
$('upload').addEventListener('click', pickFiles);
$('open-palette').addEventListener('click', () => palette.open());
$('open-palette').textContent = `Commands ${MOD}/`;
bindFilesView();

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
  await noteSync.flush();
  const id = S.noteId;
  await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: true } });
  S.note = null; S.noteId = null;
  toast('Moved to trash.');
  S.notes = S.notes.filter((x) => x.id !== id);
  allNotes = null;
  go(listHash());
  loadTags();
});
$('restore').addEventListener('click', async () => {
  const id = S.noteId;
  await api(`/api/notes/${id}`, { method: 'PUT', body: { trashed: false } });
  S.note = null; S.noteId = null; S.listLoaded = false; allNotes = null;
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
      await loadDiary();
      renderRail();
      renderDiaryCount(wordCount(diaryEd.getDoc()));
      toast(`Goal: ${n(v)} words.`);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.dataset.cancel = 1; input.blur(); } });
  input.addEventListener('blur', () => done(!input.dataset.cancel), { once: true });
});

// Capture phase, so ⌘/ wins over the editor's own bindings.
addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); e.stopPropagation(); palette.toggle(); return; }
  if (palette.isOpen) return;
  if (e.key === 'Escape' && !$('viewer').hidden) { closeViewer(); return; }
  if (mod && e.key === '.') { e.preventDefault(); toggle('full'); }
  else if (e.key === 'Escape' && document.body.classList.contains('full')) toggle('full');
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); }
  else if (mod && e.altKey && e.code === 'KeyN') { e.preventDefault(); newNote(); }
  else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); go('#/today'); }
}, true);

addEventListener('hashchange', () => route().catch((e) => toast(e.message, true)));
addEventListener('pagehide', () => { noteSync.beacon(); diarySync.beacon(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { noteSync.flush(); diarySync.flush(); }
  else { checkRollover(); pullRemote(); }
});
addEventListener('focus', () => pullRemote());

// Bring in edits made on another device while this one sits idle on the same note or day.
async function pullRemote() {
  if (document.visibilityState !== 'visible') return;
  try {
    if (S.noteId && S.view !== 'diary' && S.view !== 'files') {
      const id = S.noteId;
      if (await noteSync.pull(id, () => api(`/api/notes/${id}`))) $('note-status').textContent = 'Updated from another device';
    } else if (S.view === 'diary' && S.day) {
      const day = S.day;
      if (await diarySync.pull('day:' + day, () => api(`/api/diary/${day}`))) {
        $('diary-status').textContent = 'Updated from another device';
        S.diaryAt = 0;
        await loadDiary();
        renderRail();
      }
    }
  } catch { /* offline; try again later */ }
}
setInterval(pullRemote, 15e3);

// The diary day changes at 3 a.m.; move to the new page if nothing is pending.
function checkRollover() {
  if (!S.diary || S.view !== 'diary' || diarySync.dirty) return;
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

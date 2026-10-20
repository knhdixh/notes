// Files: a plain browser over everything uploaded, with a preview for images.
import { $, api, esc, toast, fmtDate, fmtSize, fmtShortDay, plural, fuzzy } from '/ui.js';
import { isImage, uploadFile } from '/uploads.js';

export const files = { list: [], loaded: false, filter: 'all', q: '' };

export async function loadFiles() {
  files.list = await api('/api/files');
  files.loaded = true;
  return files.list;
}

const ext = (name) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toLowerCase();

function usedIn(f) {
  if (!f.usedIn.length) return 'unused';
  return 'in ' + f.usedIn.map((u) => (u.kind === 'note'
    ? `<a class="link" href="#/notes/${u.id}">${esc(u.title)}</a>`
    : `<a class="link" href="#/day/${u.id}">${esc(fmtShortDay(u.id))} diary</a>`)).join(', ');
}

export function renderFiles() {
  const shown = files.list
    .filter((f) => files.filter === 'all' || (files.filter === 'images') === isImage(f.type))
    .map((f) => ({ f, s: fuzzy(files.q, f.name) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => (files.q ? b.s - a.s : 0))
    .map((x) => x.f);
  const total = files.list.reduce((t, f) => t + f.size, 0);
  $('files-n').textContent = files.list.length ? `${plural(files.list.length, 'file')} · ${fmtSize(total)}` : '';
  document.querySelectorAll('[data-ffilter]').forEach((b) => b.classList.toggle('on', b.dataset.ffilter === files.filter));
  const ul = $('file-rows');
  if (!shown.length) {
    ul.innerHTML = `<li class="empty">${files.list.length ? 'Nothing matches.' : 'No files yet. Drop some here, or into any note.'}</li>`;
    return;
  }
  ul.innerHTML = shown.map((f) => `
    <li class="file-row" data-id="${f.id}">
      <button class="thumb" data-open="${f.id}" aria-label="Open ${esc(f.name)}">
        ${isImage(f.type) ? `<img src="${esc(f.url)}" alt="" loading="lazy">` : `<span>${esc(ext(f.name))}</span>`}
      </button>
      <div class="file-main">
        <button class="file-name" data-open="${f.id}">${esc(f.name)}</button>
        <div class="file-meta">${fmtSize(f.size)} · ${fmtDate(f.created_at)} · ${usedIn(f)}</div>
      </div>
      <div class="file-actions">
        <button class="tool" data-copy="${f.id}">copy</button>
        <button class="tool" data-rename="${f.id}">rename</button>
        <button class="tool danger-tool" data-del="${f.id}">delete</button>
      </div>
    </li>`).join('');
}

export function openViewer(f) {
  if (!isImage(f.type)) { window.open(f.url, '_blank', 'noopener'); return; }
  $('viewer-img').src = f.url;
  $('viewer-img').alt = f.name;
  $('viewer-name').textContent = f.name;
  $('viewer-open').href = f.url;
  $('viewer').hidden = false;
}

export function closeViewer() { $('viewer').hidden = true; $('viewer-img').removeAttribute('src'); }

export async function uploadToLibrary(list) {
  const arr = [...list];
  if (!arr.length) return;
  toast(`Uploading ${plural(arr.length, 'file')}…`);
  let ok = 0;
  for (const file of arr) {
    try { await uploadFile(file); ok++; } catch (e) { toast(e.message, true); }
  }
  if (ok) toast(`${plural(ok, 'file')} uploaded.`);
  await loadFiles();
  renderFiles();
}

export function bindFilesView() {
  const byId = (id) => files.list.find((f) => f.id === id);
  $('file-rows').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-open],[data-copy],[data-rename],[data-del]');
    if (!t) return;
    const f = byId(t.dataset.open || t.dataset.copy || t.dataset.rename || t.dataset.del);
    if (!f) return;
    if (t.dataset.open) openViewer(f);
    else if (t.dataset.copy) {
      const md = isImage(f.type) ? `![${f.name.replace(/\.[^.]+$/, '')}](${f.url})` : `[${f.name}](${f.url})`;
      try { await navigator.clipboard.writeText(md); toast('Copied. Paste it into a note.'); } catch { toast(md); }
    } else if (t.dataset.rename) {
      const name = prompt('Rename file', f.name);
      if (!name || name === f.name) return;
      try { Object.assign(f, await api(`/api/files/${f.id}`, { method: 'PUT', body: { name } })); renderFiles(); } catch (err) { toast(err.message, true); }
    } else if (t.dataset.del) {
      const where = f.usedIn.length ? ` It's used in ${plural(f.usedIn.length, 'place')}, which will show a broken link.` : '';
      if (!confirm(`Delete ${f.name}?${where}`)) return;
      try {
        await api(`/api/files/${f.id}`, { method: 'DELETE' });
        files.list = files.list.filter((x) => x.id !== f.id);
        renderFiles();
        toast('Deleted.');
      } catch (err) { toast(err.message, true); }
    }
  });
  document.querySelectorAll('[data-ffilter]').forEach((b) => b.addEventListener('click', () => { files.filter = b.dataset.ffilter; renderFiles(); }));
  $('files-search').addEventListener('input', (e) => { files.q = e.target.value; renderFiles(); });
  $('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer' || e.target.id === 'viewer-close') closeViewer(); });
}

// Command palette (⌘/), in the spirit of Todoist's command menu: one input, ranked results in
// sections, arrow keys to move, Enter to run.
import { $, esc } from '/ui.js';

// source(query) → [{ title, items: [{ label, hint, meta, run }] }], may be async.
export function createPalette(source) {
  const root = $('palette'), input = $('pal-input'), list = $('pal-list');
  let items = [], sel = 0, seq = 0, lastFocus = null;

  async function refresh() {
    const mine = ++seq;
    const sections = (await source(input.value)).filter((s) => s.items.length);
    if (mine !== seq) return; // a newer keystroke won
    items = sections.flatMap((s) => s.items);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let i = 0;
    list.innerHTML = sections.length ? sections.map((s) => `
      <li class="pal-sec" role="presentation">${esc(s.title)}</li>
      ${s.items.map((it) => {
        const k = i++;
        return `<li class="pal-item${k === sel ? ' on' : ''}" role="option" id="pal-${k}" data-k="${k}" aria-selected="${k === sel}">
          <span class="pal-label">${esc(it.label)}</span>${it.meta ? `<span class="pal-meta">${esc(it.meta)}</span>` : ''}
          ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</li>`;
      }).join('')}`).join('') : '<li class="pal-empty">No matches.</li>';
    input.setAttribute('aria-activedescendant', items.length ? `pal-${sel}` : '');
  }

  function move(d) {
    if (!items.length) return;
    list.querySelector('.pal-item.on')?.classList.remove('on');
    sel = (sel + d + items.length) % items.length;
    const el = $(`pal-${sel}`);
    el.classList.add('on');
    el.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `pal-${sel}`);
  }

  function run(k = sel) {
    const it = items[k];
    if (!it) return;
    close(false);
    it.run();
  }

  function open(prefill = '') {
    lastFocus = document.activeElement;
    root.hidden = false;
    input.value = prefill;
    sel = 0;
    refresh();
    requestAnimationFrame(() => input.focus());
  }
  function close(restore = true) {
    root.hidden = true;
    if (restore && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  input.addEventListener('input', () => { sel = 0; refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.pal-item');
    if (li && +li.dataset.k !== sel) move(+li.dataset.k - sel);
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('.pal-item'); if (li) run(+li.dataset.k); });
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });

  return { open, close, get isOpen() { return !root.hidden; }, toggle(p) { root.hidden ? open(p) : close(); } };
}

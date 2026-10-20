// Markup editor (bundled to public/vendor/editor.js by `npm run vendor`).
// Markdown stays visible but styled, as in Ulysses and Bear: muted markers, larger headings,
// #tags, clickable checkboxes, plus focus mode and typewriter scrolling.
import { EditorState, Compartment, RangeSetBuilder, StateField, Annotation, Transaction } from '@codemirror/state';
import {
  EditorView, keymap, placeholder as placeholderExt, Decoration, ViewPlugin, WidgetType, MatchDecorator, drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { parser as mdParser, GFM } from '@lezer/markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree, Language, defineLanguageFacet } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Bare markdown + GFM (lang-markdown would pull in HTML, CSS and JS grammars).
const mdLanguage = new Language(defineLanguageFacet(), mdParser.configure([GFM]), [], 'markdown');

// Enter continues lists, checklists and quotes; Enter on an empty item ends the list.
function continueMarkup(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const m = /^(\s*)(>\s?|[-*+]\s\[[ xX]\]\s|[-*+]\s|(\d+)([.)])\s)/.exec(line.text);
  if (!m || sel.head < line.from + m[0].length) return false;
  if (line.text.slice(m[0].length).trim() === '' && sel.head === line.to) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
    return true;
  }
  let marker = m[2];
  if (m[3]) marker = (+m[3] + 1) + m[4] + ' ';
  else if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, '[ ]');
  const insert = '\n' + m[1] + marker;
  view.dispatch({ changes: { from: sel.head, insert }, selection: { anchor: sel.head + insert.length }, scrollIntoView: true });
  return true;
}

const style = HighlightStyle.define([
  { tag: t.heading1, class: 'md-h md-h1' },
  { tag: t.heading2, class: 'md-h md-h2' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], class: 'md-h md-h3' },
  { tag: t.strong, class: 'md-strong' },
  { tag: t.emphasis, class: 'md-em' },
  { tag: t.strikethrough, class: 'md-strike' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], class: 'md-mark' },
  { tag: t.link, class: 'md-link' },
  { tag: t.url, class: 'md-url' },
  { tag: t.monospace, class: 'md-code' },
  { tag: t.quote, class: 'md-quote' },
]);

/* ---------- tags ---------- */
const tagMatcher = new MatchDecorator({
  regexp: /(?<=^|[\s(])#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*/gu,
  decoration: (m) => Decoration.mark({ class: 'md-tag', attributes: { 'data-tag': m[0].slice(1).replace(/\/+$/, '').toLowerCase() } }),
});
const tagPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = tagMatcher.createDeco(view); }
  update(u) { this.decorations = tagMatcher.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

/* ---------- checkboxes ---------- */
class CheckWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'md-check' + (this.checked ? ' on' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.textContent = this.checked ? '✓' : '';
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}
function checkDecos(view) {
  const b = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const m = /^(\s*[-*+]\s)\[( |x|X)\]/.exec(line.text);
      if (m) {
        const start = line.from + m[1].length;
        const checked = m[2] !== ' ';
        if (checked) b.add(line.from, line.from, Decoration.line({ class: 'md-done' }));
        b.add(start, start + 3, Decoration.replace({ widget: new CheckWidget(checked, start) }));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}
const checkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = checkDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = checkDecos(u.view); }
}, { decorations: (v) => v.decorations });

/* ---------- heading lines (for spacing) ---------- */
const headingLines = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from, to,
        enter: (n) => {
          const m = /^ATXHeading(\d)$/.exec(n.name);
          if (m) b.add(n.from, n.from, Decoration.line({ class: 'md-hline md-hline' + Math.min(3, +m[1]) }));
        },
      });
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

/* ---------- inline images: shown under their markdown line ---------- */
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'md-img';
    const img = document.createElement('img');
    img.src = this.src; img.alt = this.alt; img.loading = 'lazy'; img.draggable = false;
    img.onerror = () => wrap.classList.add('broken');
    wrap.appendChild(img);
    return wrap;
  }
  get estimatedHeight() { return 240; }
  ignoreEvent() { return false; }
}
const IMG = /!\[([^\]\n]*)\]\(((?:\/files\/|https:\/\/)[^)\s]+)\)/g;
function imageDecos(state) {
  const b = new RangeSetBuilder();
  const text = state.doc.toString();
  let lastLine = -1;
  for (const m of text.matchAll(IMG)) {
    if (m[2].startsWith('#')) continue;
    const line = state.doc.lineAt(m.index);
    if (line.number === lastLine) continue;
    lastLine = line.number;
    b.add(line.from, line.from, Decoration.line({ class: 'md-imgline' }));
    b.add(line.to, line.to, Decoration.widget({ widget: new ImageWidget(m[2], m[1]), block: true, side: 1 }));
  }
  return b.finish();
}
// Block widgets have to come from a state field, not a view plugin.
const imageField = StateField.define({
  create: (state) => imageDecos(state),
  update: (deco, tr) => (tr.docChanged ? imageDecos(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

// Markdown link or image whose target covers `pos`.
function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return m[1];
  }
  return null;
}

const remote = Annotation.define();

/* ---------- Bear-style title: the first line of a note ---------- */
const titleLine = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder();
    if (view.state.doc.line(1).text.trim()) b.add(0, 0, Decoration.line({ class: 'md-title' }));
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

/* ---------- focus mode: dim everything but the current paragraph ---------- */
const dim = Decoration.line({ class: 'md-dim' });
const focusPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const { doc } = view.state;
    const head = doc.lineAt(view.state.selection.main.head).number;
    let a = head, z = head;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    while (z < doc.lines && doc.line(z + 1).text.trim()) z++;
    const b = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        if (line.number < a || line.number > z) b.add(line.from, line.from, dim);
        pos = line.to + 1;
      }
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

/* ---------- typewriter: keep the caret line centred ---------- */
const typewriter = EditorView.updateListener.of((u) => {
  if (!(u.docChanged || u.selectionSet) || !u.view.hasFocus) return;
  const view = u.view;
  requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) }));
});

export function createEditor({ parent, doc = '', placeholder = '', onChange, onTag, onFiles, title = false }) {
  const focusC = new Compartment();
  const typeC = new Compartment();
  let opts = { focus: false, typewriter: false };

  const extensions = () => [
    history(),
    drawSelection(),
    keymap.of([{ key: 'Enter', run: continueMarkup }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    mdLanguage,
    syntaxHighlighting(style),
    EditorView.lineWrapping,
    placeholderExt(placeholder),
    tagPlugin, checkPlugin, headingLines, imageField, title ? titleLine : [],
    focusC.of(opts.focus ? focusPlugin : []),
    typeC.of(opts.typewriter ? typewriter : []),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': 'Editor' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onChange && !u.transactions.every((tr) => tr.annotation(remote))) onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      click: (e, view) => {
        if (!(e.metaKey || e.ctrlKey)) return false;
        const tag = e.target.closest && e.target.closest('.md-tag');
        if (tag && onTag) { onTag(tag.dataset.tag); return true; }
        const img = e.target.closest && e.target.closest('.md-img img');
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const href = img ? img.getAttribute('src') : pos != null && linkAt(view.state, pos);
        if (href && !href.startsWith('#')) { window.open(href, '_blank', 'noopener'); return true; }
        return false;
      },
      drop: (e, view) => {
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length || !onFiles) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        onFiles(files, pos);
        return true;
      },
      paste: (e, view) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!files.length || !onFiles) return false;
        e.preventDefault();
        onFiles(files, view.state.selection.main.head);
        return true;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: extensions() }) });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    // Replaces the document and its undo history (switching notes).
    setDoc(text, { cursorEnd = false } = {}) {
      view.setState(EditorState.create({ doc: text, extensions: extensions(), selection: cursorEnd ? { anchor: text.length } : undefined }));
    },
    focus() { view.focus(); },
    get cursor() { return view.state.selection.main.head; },
    // Puts `text` on its own line(s) near `pos`.
    insertBlock(pos, text) {
      const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
      let at, insert;
      if (!line.text.trim()) { at = line.from; insert = text; }
      else if (pos === line.from) { at = pos; insert = text + '\n'; }
      else { at = line.to; insert = '\n' + text; }
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true });
    },
    replaceText(search, replacement) {
      const i = view.state.doc.toString().indexOf(search);
      if (i < 0) return false;
      view.dispatch({ changes: { from: i, to: i + search.length, insert: replacement } });
      return true;
    },
    // Applies text that came from another device as a minimal change, keeping the cursor
    // and not triggering onChange.
    applyRemote(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let a = 0;
      while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
      let z = 0;
      while (z < cur.length - a && z < text.length - a && cur[cur.length - 1 - z] === text[text.length - 1 - z]) z++;
      view.dispatch({
        changes: { from: a, to: cur.length - z, insert: text.slice(a, text.length - z) },
        annotations: [remote.of(true), Transaction.addToHistory.of(false)],
      });
    },
    setOptions(next) {
      opts = { ...opts, ...next };
      view.dispatch({ effects: [
        focusC.reconfigure(opts.focus ? focusPlugin : []),
        typeC.reconfigure(opts.typewriter ? typewriter : []),
      ] });
    },
  };
}

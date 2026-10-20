// Markup editor (bundled to public/vendor/editor.js by `npm run vendor`).
// Markdown stays visible but styled, as in Ulysses and Bear: muted markers, larger headings,
// #tags, clickable checkboxes, plus focus mode and typewriter scrolling.
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
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
  { tag: [t.link, t.url], class: 'md-link' },
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

export function createEditor({ parent, doc = '', placeholder = '', onChange, onTag, title = false }) {
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
    tagPlugin, checkPlugin, headingLines, title ? titleLine : [],
    focusC.of(opts.focus ? focusPlugin : []),
    typeC.of(opts.typewriter ? typewriter : []),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': 'Editor' }),
    EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(u.state.doc.toString()); }),
    EditorView.domEventHandlers({
      click: (e) => {
        const tag = e.target.closest && e.target.closest('.md-tag');
        if (tag && onTag && (e.metaKey || e.ctrlKey)) { onTag(tag.dataset.tag); return true; }
        return false;
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
    setOptions(next) {
      opts = { ...opts, ...next };
      view.dispatch({ effects: [
        focusC.reconfigure(opts.focus ? focusPlugin : []),
        typeC.reconfigure(opts.typewriter ? typewriter : []),
      ] });
    },
  };
}

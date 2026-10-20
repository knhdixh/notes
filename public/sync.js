// Autosave that stays correct across devices.
// Every save carries the version this device last saw. If another device saved in between, the
// server answers 409 with its copy; we merge (three-way, line based) and save the result.
// A local draft with its base is kept until the server confirms, so a closed tab or lost
// connection never loses text, and an old draft is merged rather than pasted over newer edits.
import { merge3 } from '/lib.js';
import { api, store, toast } from '/ui.js';

export function createSync({ ctx, url, current, apply, onSaved, onState, docOf }) {
  const bases = new Map();               // key -> { version, body } last agreed with the server
  let timer, retry, pending = null, inflight = false, warned = false;

  const saveDraft = (key, text) => {
    const b = bases.get(key);
    store.set('draft:' + key, { text, baseVersion: b ? b.version : null, baseBody: b ? b.body : null });
  };

  async function run() {
    clearTimeout(timer);
    if (inflight || !pending) return;
    const job = pending;
    pending = null; inflight = true;
    onState('saving');
    let text = current(job.key) ?? job.text, conflicts = 0, merged = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const base = bases.get(job.key);
        try {
          const res = await api(url(job.key), { method: 'PUT', body: { body: text, base_version: base ? base.version : undefined } });
          bases.set(job.key, { version: docOf(res).version, body: text });
          onSaved(job.key, res);
          break;
        } catch (e) {
          if (e.status !== 409 || attempt >= 3) throw e;
          const theirs = docOf(e.data);
          const live = current(job.key) ?? text;
          const m = merge3(base ? base.body : theirs.body, live, theirs.body);
          bases.set(job.key, { version: theirs.version, body: theirs.body });
          apply(job.key, m.text);
          text = m.text; conflicts += m.conflicts; merged = true;
        }
      }
      inflight = false; warned = false;
      if (!pending) { store.del('draft:' + job.key); onState(merged ? 'merged' : 'saved'); } else run();
      if (conflicts) toast('Merged edits from another device. Both versions of overlapping lines were kept.');
    } catch (e) {
      inflight = false;
      if (!pending) pending = job;
      onState('offline');
      clearTimeout(retry);
      retry = setTimeout(run, 5000);
      if (!warned && !/Offline|Signed out/.test(e.message)) { warned = true; toast(e.message, true); }
    }
  }

  return {
    push(text) {
      const key = ctx();
      pending = { key, text };
      saveDraft(key, text);
      onState('edited');
      clearTimeout(timer);
      timer = setTimeout(run, 700);
    },
    flush: run,
    get dirty() { return !!pending || inflight; },

    // Called when a doc is opened with the server's copy. Returns the text to show and whether
    // it still needs saving (a leftover local draft).
    open(key, server) {
      bases.set(key, { version: server.version, body: server.body });
      const draft = store.get('draft:' + key, null);
      if (!draft) return { text: server.body, dirty: false };
      const d = typeof draft === 'string' ? { text: draft, baseVersion: server.version, baseBody: server.body } : draft;
      if (d.text === server.body) { store.del('draft:' + key); return { text: server.body, dirty: false }; }
      if (d.baseVersion === server.version) return { text: d.text, dirty: true };
      return { text: merge3(d.baseBody ?? server.body, d.text, server.body).text, dirty: true };
    },

    // Pulls another device's newer copy into an open, idle doc.
    async pull(key, fetchDoc) {
      if (pending || inflight) return false;
      const server = await fetchDoc();
      const base = bases.get(key);
      if (pending || inflight || ctx() !== key || !base || server.version <= base.version) return false;
      bases.set(key, { version: server.version, body: server.body });
      apply(key, server.body);
      return true;
    },

    beacon() {
      if (!pending) return;
      const base = bases.get(pending.key);
      fetch(url(pending.key), {
        method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: current(pending.key) ?? pending.text, base_version: base ? base.version : undefined }),
      });
    },
  };
}

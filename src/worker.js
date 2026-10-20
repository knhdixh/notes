// notes: Worker entry. /api/* is handled here; everything else is static (public/).
import { verifyAccess } from './access.js';
import { uploadFile, listFiles, renameFile, deleteFile, serveFile, FileError } from './files.js';
import {
  DEFAULT_GOAL, wordCount, localDay, validTimeZone, isDay, extractTags, extractFileIds, noteTitle, noteSnippet, computeStreak,
} from '../public/lib.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, init) => Response.json(data, init);
const MAX_BODY = 500_000;

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY * 1.2) throw new HttpError(413, 'Too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function checkBody(body) {
  if (typeof body !== 'string') throw new HttpError(400, 'body must be text.');
  if (body.length > MAX_BODY) throw new HttpError(413, 'Note is too long.');
  return body;
}

/* ---------- settings ---------- */

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { goal: Number(s.goal) || DEFAULT_GOAL, tz: validTimeZone(s.tz) ? s.tz : 'UTC' };
}

const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

// Remembers the browser's zone so the server agrees on what "today" is.
async function resolveTz(env, url, settings) {
  const tz = url.searchParams.get('tz');
  if (tz && validTimeZone(tz) && tz !== settings.tz) {
    await setSetting(env, 'tz', tz).run();
    settings.tz = tz;
  }
  return settings.tz;
}

/* ---------- notes ---------- */

const NOTE_COLS = 'id, title, snippet, words, pinned, version, created_at, updated_at, trashed_at';

async function withTags(env, notes) {
  if (!notes.length) return notes;
  const { results } = await env.DB.prepare(
    'SELECT note_id, tag FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?))',
  ).bind(JSON.stringify(notes.map((n) => n.id))).all();
  const map = {};
  for (const r of results) (map[r.note_id] ||= []).push(r.tag);
  return notes.map((n) => ({ ...n, pinned: !!n.pinned, tags: (map[n.id] || []).sort() }));
}

async function listNotes(env, url) {
  const trash = url.searchParams.get('trash') === '1';
  const tag = (url.searchParams.get('tag') || '').toLowerCase();
  const q = (url.searchParams.get('q') || '').trim();
  const where = [trash ? 'n.trashed_at IS NOT NULL' : 'n.trashed_at IS NULL'];
  const args = [];
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND (t.tag = ? OR t.tag LIKE ?))');
    args.push(tag, tag.replace(/[%_]/g, '') + '/%');
  }
  if (q) {
    const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
    where.push("n.body LIKE ? ESCAPE '\\'");
    args.push(like);
  }
  const order = trash ? 'n.trashed_at DESC' : 'n.pinned DESC, n.updated_at DESC';
  const { results } = await env.DB.prepare(
    `SELECT ${NOTE_COLS.split(', ').map((c) => 'n.' + c).join(', ')} FROM notes n WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`,
  ).bind(...args).all();
  return withTags(env, results);
}

async function getNote(env, id) {
  const n = await env.DB.prepare(`SELECT ${NOTE_COLS}, body FROM notes WHERE id = ?`).bind(id).first();
  if (!n) throw new HttpError(404, 'Note not found.');
  return (await withTags(env, [n]))[0];
}

function noteFields(body) {
  return { title: noteTitle(body), snippet: noteSnippet(body), words: wordCount(body), tags: extractTags(body) };
}

function tagStatements(env, id, tags) {
  return [
    env.DB.prepare('DELETE FROM note_tags WHERE note_id = ?').bind(id),
    env.DB.prepare('INSERT INTO note_tags (note_id, tag) SELECT ?, value FROM json_each(?)').bind(id, JSON.stringify(tags)),
  ];
}

function refStatements(env, ref, body) {
  return [
    env.DB.prepare('DELETE FROM file_refs WHERE ref = ?').bind(ref),
    env.DB.prepare('INSERT OR IGNORE INTO file_refs (ref, file_id) SELECT ?, value FROM json_each(?)').bind(ref, JSON.stringify(extractFileIds(body))),
  ];
}

async function createNote(env, input) {
  const body = checkBody(input.body ?? '');
  const id = crypto.randomUUID();
  const now = Date.now();
  const f = noteFields(body);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (id, body, title, snippet, words, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, body, f.title, f.snippet, f.words, input.pinned ? 1 : 0, now, now),
    ...tagStatements(env, id, f.tags),
    ...refStatements(env, 'note:' + id, body),
  ]);
  return getNote(env, id);
}

async function updateNote(env, id, input) {
  const existing = await env.DB.prepare('SELECT id, version FROM notes WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Note not found.');
  const now = Date.now();
  const stmts = [];
  if (input.body !== undefined) {
    // Another device saved since this one last synced: hand back the current note to merge with.
    if (input.base_version !== undefined && input.base_version !== existing.version) {
      return { conflict: true, note: await getNote(env, id) };
    }
    const body = checkBody(input.body);
    const f = noteFields(body);
    stmts.push(
      env.DB.prepare('UPDATE notes SET body = ?, title = ?, snippet = ?, words = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .bind(body, f.title, f.snippet, f.words, now, id),
      ...tagStatements(env, id, f.tags),
      ...refStatements(env, 'note:' + id, body),
    );
  }
  if (input.pinned !== undefined) stmts.push(env.DB.prepare('UPDATE notes SET pinned = ? WHERE id = ?').bind(input.pinned ? 1 : 0, id));
  if (input.trashed !== undefined) {
    stmts.push(env.DB.prepare('UPDATE notes SET trashed_at = ? WHERE id = ?').bind(input.trashed ? now : null, id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getNote(env, id);
}

async function listTags(env) {
  const { results } = await env.DB.prepare(
    `SELECT t.tag, COUNT(*) AS count FROM note_tags t JOIN notes n ON n.id = t.note_id
     WHERE n.trashed_at IS NULL GROUP BY t.tag ORDER BY t.tag`,
  ).all();
  return results;
}

/* ---------- diary ---------- */

async function diaryState(env, settings) {
  const today = localDay(Date.now(), settings.tz);
  const { results } = await env.DB.prepare('SELECT day, words, completed FROM entries ORDER BY day').all();
  const stats = computeStreak(results.map((r) => ({ ...r, completed: !!r.completed })), today, settings.goal);
  return { today, tz: settings.tz, days: results.map((r) => ({ day: r.day, words: r.words })), stats };
}

async function getEntry(env, day) {
  return (await env.DB.prepare('SELECT day, body, words, completed, completed_at, started_at, updated_at, version FROM entries WHERE day = ?').bind(day).first())
    || { day, body: '', words: 0, completed: 0, completed_at: null, started_at: null, updated_at: null, version: 0 };
}

async function saveEntry(env, settings, day, input) {
  const body = checkBody(input.body);
  const today = localDay(Date.now(), settings.tz);
  if (day > today) throw new HttpError(400, 'That day has not started yet.');
  if (input.base_version !== undefined) {
    const current = await getEntry(env, day);
    if (current.version !== input.base_version) return { conflict: true, entry: current };
  }
  const words = wordCount(body);
  const now = Date.now();
  // A day is completed only if the goal is reached on that day; edits later don't count.
  const completesNow = day === today && words >= settings.goal ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entries (day, body, words, completed, completed_at, started_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 = 1 THEN ?5 END, ?5, ?5)
       ON CONFLICT(day) DO UPDATE SET body = ?2, words = ?3, updated_at = ?5, version = version + 1,
         completed = MAX(completed, ?4),
         completed_at = COALESCE(completed_at, CASE WHEN ?4 = 1 THEN ?5 END)`,
    ).bind(day, body, words, completesNow, now),
    ...refStatements(env, 'day:' + day, body),
  ]);
  return { entry: await getEntry(env, day) };
}

/* ---------- router ---------- */

async function handleApi(request, env, url) {
  const { pathname: p } = url;
  const m = request.method;

  if (p === '/api/health' && m === 'GET') return json({ ok: true });

  const email = await verifyAccess(request, env);
  if (!email) throw new HttpError(401, 'Not signed in.');

  if (p === '/api/me' && m === 'GET') return json({ email });

  if (p === '/api/notes' && m === 'GET') return json(await listNotes(env, url));
  if (p === '/api/notes' && m === 'POST') return json(await createNote(env, await readJson(request)), { status: 201 });
  if (p === '/api/tags' && m === 'GET') return json(await listTags(env));

  const nm = p.match(/^\/api\/notes\/([0-9a-f-]{36})$/);
  if (nm) {
    if (m === 'GET') return json(await getNote(env, nm[1]));
    if (m === 'PUT') {
      const r = await updateNote(env, nm[1], await readJson(request));
      return r.conflict ? json({ error: 'Changed on another device.', note: r.note }, { status: 409 }) : json(r);
    }
    if (m === 'DELETE') {
      // Only notes already in the trash can be deleted for good.
      const [r] = await env.DB.batch([
        env.DB.prepare('DELETE FROM notes WHERE id = ? AND trashed_at IS NOT NULL').bind(nm[1]),
        env.DB.prepare("DELETE FROM file_refs WHERE ref = 'note:' || ? AND NOT EXISTS (SELECT 1 FROM notes WHERE id = ?)").bind(nm[1], nm[1]),
      ]);
      if (!r.meta.changes) throw new HttpError(404, 'Note not in trash.');
      return json({ ok: true });
    }
  }
  if (p === '/api/trash' && m === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM file_refs WHERE ref IN (SELECT 'note:' || id FROM notes WHERE trashed_at IS NOT NULL)"),
      env.DB.prepare('DELETE FROM notes WHERE trashed_at IS NOT NULL'),
    ]);
    return json({ ok: true });
  }

  if (p === '/api/diary' && m === 'GET') {
    const settings = await getSettings(env);
    await resolveTz(env, url, settings);
    const state = await diaryState(env, settings);
    return json({ ...state, entry: await getEntry(env, state.today) });
  }
  const dm = p.match(/^\/api\/diary\/(\d{4}-\d{2}-\d{2})$/);
  if (dm && isDay(dm[1])) {
    const settings = await getSettings(env);
    await resolveTz(env, url, settings);
    if (m === 'GET') return json(await getEntry(env, dm[1]));
    if (m === 'PUT') {
      const r = await saveEntry(env, settings, dm[1], await readJson(request));
      if (r.conflict) return json({ error: 'Changed on another device.', entry: r.entry }, { status: 409 });
      return json({ entry: r.entry, ...(await diaryState(env, settings)) });
    }
  }

  if (p === '/api/files' && m === 'GET') return json(await listFiles(env));
  if (p === '/api/files' && m === 'POST') return json(await uploadFile(env, request), { status: 201 });
  const fm = p.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (fm && m === 'PUT') return json(await renameFile(env, fm[1], (await readJson(request)).name));
  if (fm && m === 'DELETE') { await deleteFile(env, fm[1]); return json({ ok: true }); }

  if (p === '/api/settings' && m === 'PUT') {
    const input = await readJson(request);
    const goal = Number(input.goal);
    if (!Number.isInteger(goal) || goal < 50 || goal > 10000) throw new HttpError(400, 'Goal must be 50–10000 words.');
    await setSetting(env, 'goal', goal).run();
    return json(await getSettings(env));
  }

  if (p === '/api/export' && m === 'GET') {
    const notes = (await env.DB.prepare('SELECT * FROM notes ORDER BY created_at').all()).results;
    const entries = (await env.DB.prepare('SELECT * FROM entries ORDER BY day').all()).results;
    return json({ exported_at: new Date().toISOString(), notes, entries }, {
      headers: { 'Content-Disposition': `attachment; filename="notes-${new Date().toISOString().slice(0, 10)}.json"` },
    });
  }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // One canonical host: Access only guards the custom domain.
      if (env.CANONICAL_HOST && url.hostname.endsWith('.workers.dev')) {
        url.hostname = env.CANONICAL_HOST;
        return Response.redirect(url.toString(), ['GET', 'HEAD'].includes(request.method) ? 301 : 308);
      }
      // Reject cross-site state-changing requests.
      if (!['GET', 'HEAD'].includes(request.method)) {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request rejected.');
      }
      const file = url.pathname.match(/^\/files\/([0-9a-f-]{36})(\/|$)/);
      if (file && ['GET', 'HEAD'].includes(request.method)) {
        if (!(await verifyAccess(request, env))) return new Response('Not signed in.', { status: 401 });
        return await serveFile(env, file[1], request);
      }
      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url);
        res.headers.set('Cache-Control', 'no-store');
        return res;
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError || e instanceof FileError) return json({ error: e.message }, { status: e.status });
      console.error(e);
      return json({ error: 'Internal error.' }, { status: 500 });
    }
  },
};

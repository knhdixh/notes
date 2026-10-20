// Uploaded files, stored in D1 as 1 MB chunks (D1 rows max out at 2 MB).
export const MAX_FILE = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;

// Types the browser may render inline; everything else downloads.
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/pdf|text\/plain)$/;

export class FileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200);
  return n || 'file';
}

function cleanType(type) {
  return /^[a-z]+\/[a-z0-9.+-]+$/i.test(type || '') ? type.toLowerCase() : 'application/octet-stream';
}

export const fileUrl = (f) => `/files/${f.id}/${encodeURIComponent(f.name)}`;

export async function uploadFile(env, request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_FILE) throw new FileError(413, 'Files can be up to 10 MB.');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) throw new FileError(400, 'Empty file.');
  if (buf.length > MAX_FILE) throw new FileError(413, 'Files can be up to 10 MB.');
  let name;
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); } catch { name = ''; }
  const f = {
    id: crypto.randomUUID(), name: cleanName(name), type: cleanType(request.headers.get('Content-Type')),
    size: buf.length, chunks: Math.ceil(buf.length / CHUNK), created_at: Date.now(),
  };
  // One statement per chunk keeps each D1 request small; the files row goes last, so a file only
  // appears once all of it is stored.
  for (let i = 0; i < f.chunks; i++) {
    await env.DB.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)')
      .bind(f.id, i, buf.subarray(i * CHUNK, (i + 1) * CHUNK)).run();
  }
  await env.DB.prepare('INSERT INTO files (id, name, type, size, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(f.id, f.name, f.type, f.size, f.chunks, f.created_at).run();
  return { ...f, url: fileUrl(f) };
}

export async function listFiles(env) {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.name, f.type, f.size, f.created_at,
       (SELECT json_group_array(ref) FROM file_refs r WHERE r.file_id = f.id) AS refs
     FROM files f ORDER BY f.created_at DESC LIMIT 1000`,
  ).all();
  const files = results.map((f) => ({ ...f, refs: JSON.parse(f.refs || '[]') }));
  // Resolve note refs to titles in one query.
  const noteIds = [...new Set(files.flatMap((f) => f.refs.filter((r) => r.startsWith('note:')).map((r) => r.slice(5))))];
  const titles = {};
  if (noteIds.length) {
    const { results: notes } = await env.DB.prepare(
      'SELECT id, title, trashed_at FROM notes WHERE id IN (SELECT value FROM json_each(?))',
    ).bind(JSON.stringify(noteIds)).all();
    for (const n of notes) titles[n.id] = { title: n.title || 'Untitled', trashed: !!n.trashed_at };
  }
  return files.map((f) => ({
    id: f.id, name: f.name, type: f.type, size: f.size, created_at: f.created_at, url: fileUrl(f),
    usedIn: f.refs.map((r) => (r.startsWith('note:')
      ? { kind: 'note', id: r.slice(5), ...(titles[r.slice(5)] || { title: 'Deleted note', trashed: true }) }
      : { kind: 'day', id: r.slice(4), title: r.slice(4) })),
  }));
}

export async function renameFile(env, id, name) {
  const r = await env.DB.prepare('UPDATE files SET name = ? WHERE id = ?').bind(cleanName(name), id).run();
  if (!r.meta.changes) throw new FileError(404, 'File not found.');
  const f = await env.DB.prepare('SELECT id, name, type, size, created_at FROM files WHERE id = ?').bind(id).first();
  return { ...f, url: fileUrl(f) };
}

export async function deleteFile(env, id) {
  const [r] = await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id),
    env.DB.prepare('DELETE FROM file_refs WHERE file_id = ?').bind(id),
  ]);
  if (!r.meta.changes) throw new FileError(404, 'File not found.');
}

export async function serveFile(env, id, request) {
  const f = await env.DB.prepare('SELECT id, name, type, size, chunks FROM files WHERE id = ?').bind(id).first();
  if (!f) return new Response('Not found.', { status: 404 });
  const etag = `"${f.id}"`;
  const headers = {
    'Content-Type': f.type,
    'Content-Length': String(f.size),
    // Ids never change content, so the browser may keep it; private because it's behind Access.
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    // Uploaded HTML/SVG must never run as this site.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    'Content-Disposition': `${INLINE.test(f.type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  if (request.method === 'HEAD') return new Response(null, { headers });
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= f.chunks) { controller.close(); return; }
      const row = await env.DB.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?').bind(f.id, i++).first();
      if (!row) { controller.error(new Error('Missing chunk.')); return; }
      controller.enqueue(new Uint8Array(row.data));
    },
  });
  return new Response(body, { headers });
}

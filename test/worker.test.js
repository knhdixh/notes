import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { verifyAccess, resetJwksCache } from '../src/access.js';
import { d1 } from './d1-shim.js';
import { localDay } from '../public/lib.js';

let env;
beforeEach(() => {
  env = { DB: d1(), DEV_LOGIN: '1', OWNER_EMAIL: 'me@example.com', ASSETS: { fetch: async () => new Response('static') } };
});

const call = async (path, init = {}) => {
  const res = await worker.fetch(new Request('https://app.test' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
  }), env);
  return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), res };
};

test('health endpoint and static fallthrough', async () => {
  assert.deepEqual((await call('/api/health')).data, { ok: true });
  assert.equal((await call('/')).data, 'static');
  assert.equal((await call('/api/nope')).status, 404);
});

test('cross-origin writes are rejected', async () => {
  const r = await call('/api/notes', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: {} });
  assert.equal(r.status, 403);
});

test('API requires Access when DEV_LOGIN is off', async () => {
  env.DEV_LOGIN = undefined;
  assert.equal((await call('/api/notes')).status, 401);
  assert.equal((await call('/api/health')).status, 200);
});

test('workers.dev redirects to the canonical host', async () => {
  env.CANONICAL_HOST = 'notes.example.com';
  const res = await worker.fetch(new Request('https://notes.someone.workers.dev/x?y=1'), env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://notes.example.com/x?y=1');
});

test('notes: create, tag, search, pin, trash, restore, purge', async () => {
  const a = (await call('/api/notes', { method: 'POST', body: { body: '# Groceries\nmilk #home/errands' } })).data;
  assert.equal(a.title, 'Groceries');
  assert.deepEqual(a.tags, ['home/errands']);
  const b = (await call('/api/notes', { method: 'POST', body: { body: 'Book idea #writing' } })).data;

  assert.equal((await call('/api/notes')).data.length, 2);
  assert.deepEqual((await call('/api/notes?tag=home')).data.map((n) => n.id), [a.id]);
  assert.deepEqual((await call('/api/notes?q=book')).data.map((n) => n.id), [b.id]);
  assert.deepEqual((await call('/api/tags')).data, [{ tag: 'home/errands', count: 1 }, { tag: 'writing', count: 1 }]);

  await call(`/api/notes/${a.id}`, { method: 'PUT', body: { pinned: true } });
  assert.equal((await call('/api/notes')).data[0].id, a.id);

  const edited = (await call(`/api/notes/${b.id}`, { method: 'PUT', body: { body: 'Book idea, renamed #novel' } })).data;
  assert.deepEqual(edited.tags, ['novel']);

  assert.equal((await call(`/api/notes/${b.id}`, { method: 'DELETE' })).status, 404, 'cannot purge outside trash');
  await call(`/api/notes/${b.id}`, { method: 'PUT', body: { trashed: true } });
  assert.equal((await call('/api/notes')).data.length, 1);
  assert.equal((await call('/api/notes?trash=1')).data.length, 1);
  assert.deepEqual((await call('/api/tags')).data.map((t) => t.tag), ['home/errands']);
  assert.equal((await call(`/api/notes/${b.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/notes/${b.id}`)).status, 404);
});

test('diary: goal reached today completes the day; past edits never complete', async () => {
  const tz = 'Europe/Helsinki';
  const today = localDay(Date.now(), tz);
  const state = (await call(`/api/diary?tz=${tz}`)).data;
  assert.equal(state.today, today);
  assert.equal(state.stats.current, 0);

  const long = Array(760).fill('word').join(' ');
  const saved = (await call(`/api/diary/${today}?tz=${tz}`, { method: 'PUT', body: { body: long } })).data;
  assert.equal(saved.entry.words, 760);
  assert.equal(saved.entry.completed, 1);
  assert.equal(saved.stats.current, 1);
  assert.equal(saved.stats.todayDone, true);

  // Dropping below the goal later keeps the day completed.
  const shorter = (await call(`/api/diary/${today}?tz=${tz}`, { method: 'PUT', body: { body: 'short' } })).data;
  assert.equal(shorter.entry.completed, 1);

  const past = (await call(`/api/diary/2020-01-01?tz=${tz}`, { method: 'PUT', body: { body: long } })).data;
  assert.equal(past.entry.completed, 0);

  assert.equal((await call(`/api/diary/2999-01-01?tz=${tz}`, { method: 'PUT', body: { body: 'x' } })).status, 400);
});

test('settings goal validation and export', async () => {
  assert.equal((await call('/api/settings', { method: 'PUT', body: { goal: 5 } })).status, 400);
  assert.equal((await call('/api/settings', { method: 'PUT', body: { goal: 500 } })).data.goal, 500);
  await call('/api/notes', { method: 'POST', body: { body: 'x' } });
  const ex = await call('/api/export');
  assert.equal(ex.data.notes.length, 1);
  assert.match(ex.res.headers.get('content-disposition'), /attachment/);
});

/* ---------- Access JWT ---------- */

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function setupKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  const sign = async (payload, kid = 'k1') => {
    const head = enc({ alg: 'RS256', kid }) + '.' + enc(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(head));
    return head + '.' + Buffer.from(sig).toString('base64url');
  };
  return { sign, fetcher: async () => Response.json({ keys: [jwk] }) };
}

test('verifyAccess accepts only a valid token for the owner', async () => {
  resetJwksCache();
  const { sign, fetcher } = await setupKeys();
  const e = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud1', OWNER_EMAIL: 'Me@Example.com' };
  const now = Math.floor(Date.now() / 1000);
  const good = { aud: ['aud1'], iss: 'https://team.cloudflareaccess.com', exp: now + 600, email: 'me@example.com' };
  const req = (t) => new Request('https://x', { headers: t ? { 'Cf-Access-Jwt-Assertion': t } : {} });

  assert.equal(await verifyAccess(req(await sign(good)), e, fetcher), 'me@example.com');
  assert.equal(await verifyAccess(req(null), e, fetcher), null);
  assert.equal(await verifyAccess(req(await sign({ ...good, email: 'other@example.com' })), e, fetcher), null);
  assert.equal(await verifyAccess(req(await sign({ ...good, aud: ['other'] })), e, fetcher), null);
  assert.equal(await verifyAccess(req(await sign({ ...good, exp: now - 10 })), e, fetcher), null);
  assert.equal(await verifyAccess(req(await sign({ ...good, iss: 'https://evil' })), e, fetcher), null);
  assert.equal(await verifyAccess(req(await sign(good, 'unknown')), e, fetcher), null);
  const t = await sign(good);
  assert.equal(await verifyAccess(req(t.slice(0, -4) + 'AAAA'), e, fetcher), null, 'tampered signature');
  assert.equal(await verifyAccess(req(await sign(good)), { ...e, OWNER_EMAIL: '' }, fetcher), null, 'no owner configured');
});

/* ---------- files ---------- */

const upload = (bytes, name, type) => worker.fetch(new Request('https://app.test/api/files', {
  method: 'POST', body: bytes, headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name), 'Content-Length': String(bytes.length) },
}), env);

test('files: upload in chunks, serve, list with refs, rename, delete', async () => {
  const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => i % 251);
  const res = await upload(big, 'photo ä.jpg', 'image/jpeg');
  assert.equal(res.status, 201);
  const f = await res.json();
  assert.equal(f.size, big.length);
  assert.match(f.url, /^\/files\/[0-9a-f-]{36}\/photo%20%C3%A4\.jpg$/);

  const got = await worker.fetch(new Request('https://app.test' + f.url), env);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.match(got.headers.get('content-disposition'), /^inline/);
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), big);

  const note = (await call('/api/notes', { method: 'POST', body: { body: `Trip\n![photo](${f.url})` } })).data;
  await call(`/api/diary/${localDay(Date.now(), 'UTC')}?tz=UTC`, { method: 'PUT', body: { body: `![p](${f.url})` } });
  let list = (await call('/api/files')).data;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].usedIn.map((u) => [u.kind, u.title]).sort(), [['day', localDay(Date.now(), 'UTC')], ['note', 'Trip']]);

  // Removing the reference from the note updates usage.
  await call(`/api/notes/${note.id}`, { method: 'PUT', body: { body: 'Trip' } });
  list = (await call('/api/files')).data;
  assert.deepEqual(list[0].usedIn.map((u) => u.kind), ['day']);

  assert.equal((await call(`/api/files/${f.id}`, { method: 'PUT', body: { name: 'beach.jpg' } })).data.name, 'beach.jpg');
  assert.equal((await call(`/api/files/${f.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await worker.fetch(new Request('https://app.test' + f.url), env)).status, 404);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM file_chunks').get().n, 0);
});

test('files: risky types download, oversize rejected, serving needs Access', async () => {
  const f = await (await upload(new TextEncoder().encode('<svg onload=alert(1)>'), 'x.svg', 'image/svg+xml')).json();
  const got = await worker.fetch(new Request('https://app.test' + f.url), env);
  assert.match(got.headers.get('content-disposition'), /^attachment/);
  assert.equal((await upload(new Uint8Array(11 * 1024 * 1024), 'big.bin', 'application/octet-stream')).status, 413);
  env.DEV_LOGIN = undefined;
  assert.equal((await worker.fetch(new Request('https://app.test' + f.url), env)).status, 401);
});

/* ---------- two devices ---------- */

test('note save with a stale base_version returns 409 with the current note', async () => {
  const n = (await call('/api/notes', { method: 'POST', body: { body: 'v1' } })).data;
  assert.equal(n.version, 1);
  const a = (await call(`/api/notes/${n.id}`, { method: 'PUT', body: { body: 'from A', base_version: 1 } })).data;
  assert.equal(a.version, 2);
  const b = await call(`/api/notes/${n.id}`, { method: 'PUT', body: { body: 'from B', base_version: 1 } });
  assert.equal(b.status, 409);
  assert.equal(b.data.note.body, 'from A');
  assert.equal(b.data.note.version, 2);
  // Pinning doesn't need a version.
  assert.equal((await call(`/api/notes/${n.id}`, { method: 'PUT', body: { pinned: true } })).status, 200);
});

test('diary save with a stale base_version returns 409', async () => {
  const day = localDay(Date.now(), 'UTC');
  const first = (await call(`/api/diary/${day}?tz=UTC`, { method: 'PUT', body: { body: 'a', base_version: 0 } })).data;
  assert.equal(first.entry.version, 1);
  assert.equal((await call(`/api/diary/${day}?tz=UTC`, { method: 'PUT', body: { body: 'b', base_version: 1 } })).data.entry.version, 2);
  const stale = await call(`/api/diary/${day}?tz=UTC`, { method: 'PUT', body: { body: 'c', base_version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.entry.body, 'b');
});

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

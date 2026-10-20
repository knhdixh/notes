import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Minimal D1 shim over node:sqlite.
export function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of fs.readdirSync('migrations').sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    // Like D1's batch: statements that return rows give { results }, others { meta }.
    exec: async () => (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)
      ? { results: db.prepare(sql).all(...args), meta: {} }
      : { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.exec()); return out; } };
}

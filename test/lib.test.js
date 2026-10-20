import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount, localDay, extractTags, noteTitle, noteSnippet, computeStreak, addDays } from '../public/lib.js';

test('wordCount handles punctuation, apostrophes and other scripts', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount("It's a  well-known\nfact — 42 times."), 6);
  assert.equal(wordCount('# Heading\n- [ ] todo item'), 3);
  assert.equal(wordCount('Tiếng Việt có dấu'), 4);
});

test('localDay respects time zone and the 3am cutoff', () => {
  const t = Date.parse('2026-10-20T00:30:00Z'); // 03:30 Helsinki, 20:30 New York (19th)
  assert.equal(localDay(t, 'Europe/Helsinki'), '2026-10-20');
  assert.equal(localDay(t, 'America/New_York'), '2026-10-19');
  // 02:00 local still belongs to the previous day.
  assert.equal(localDay(Date.parse('2026-10-19T23:00:00Z'), 'Europe/Helsinki'), '2026-10-19');
});

test('extractTags finds nested tags but not headings, numbers or code', () => {
  const body = '# Title\nSome #Work/Project text #idea, see #2 and `#notatag`\n```\n#code\n```\n(#paren)';
  assert.deepEqual(extractTags(body), ['idea', 'paren', 'work/project']);
});

test('noteTitle and snippet strip markdown', () => {
  assert.equal(noteTitle('\n## **Big** idea\nbody'), 'Big idea');
  assert.equal(noteSnippet('Title\n> quoted *text*\n- [ ] item'), 'quoted text - item');
});

const run = (start, pattern) => [...pattern].map((c, i) => ({
  day: addDays(start, i), words: c === 'x' ? 800 : c === 'p' ? 200 : 0, completed: c === 'x',
})).filter((d) => d.words);

test('streak counts consecutive completed days and survives an unfinished today', () => {
  const days = run('2026-10-01', 'xxxx'); // 1..4
  const s = computeStreak(days, '2026-10-05');
  assert.equal(s.current, 4);
  assert.equal(s.atRisk, true);
  assert.equal(s.toGo, 750);
  assert.equal(s.status['2026-10-05'], 'today');
});

test('a missed day resets the streak without freezes', () => {
  const s = computeStreak(run('2026-10-01', 'xxx.xx'), '2026-10-06');
  assert.equal(s.current, 2);
  assert.equal(s.longest, 3);
  assert.equal(s.status['2026-10-04'], 'missed');
});

test('a partial day is not a completed day', () => {
  const s = computeStreak(run('2026-10-01', 'xxpx'), '2026-10-04');
  assert.equal(s.current, 1);
  assert.equal(s.status['2026-10-03'], 'partial');
});

test('every 7 completed days earns a freeze that covers a missed day', () => {
  const s = computeStreak(run('2026-10-01', 'xxxxxxx.xx'), '2026-10-10');
  assert.equal(s.status['2026-10-08'], 'frozen');
  assert.equal(s.current, 9);
  assert.equal(s.freezes, 0);
  assert.equal(s.todayDone, true);
  assert.equal(s.atRisk, false);
});

test('freezes cap at 2 and are spent one per missed day', () => {
  const s = computeStreak(run('2026-09-01', 'x'.repeat(21) + '...x'), '2026-09-25');
  // 21 days → 3 earned, capped at 2; two misses frozen, third resets.
  assert.equal(s.status['2026-09-22'], 'frozen');
  assert.equal(s.status['2026-09-23'], 'frozen');
  assert.equal(s.status['2026-09-24'], 'missed');
  assert.equal(s.current, 1);
  assert.equal(s.longest, 21);
});

test('empty history', () => {
  const s = computeStreak([], '2026-10-20');
  assert.equal(s.current, 0);
  assert.equal(s.atRisk, false);
  assert.equal(s.nextFreezeIn, 7);
});

import { merge3, extractFileIds } from '../public/lib.js';

test('wordCount ignores image and link targets', () => {
  assert.equal(wordCount('A photo ![sunset over the lake](/files/0b6e7d6c-1111-4c1e-9a2b-123456789abc/sunset.jpg) and [a link](https://example.com/very/long/path)'), 5);
});

test('extractFileIds finds file references', () => {
  const id = '0b6e7d6c-1111-4c1e-9a2b-123456789abc';
  assert.deepEqual(extractFileIds(`![x](/files/${id}/x.png) [y](/files/${id}/y.pdf)`), [id]);
});

test('merge3: edits to different lines both survive', () => {
  const base = 'title\none\ntwo\nthree';
  const r = merge3(base, 'title\nONE\ntwo\nthree', 'title\none\ntwo\nTHREE\nfour');
  assert.deepEqual(r, { text: 'title\nONE\ntwo\nTHREE\nfour', conflicts: 0 });
});

test('merge3: one side unchanged or both identical', () => {
  assert.equal(merge3('a', 'a', 'b').text, 'b');
  assert.equal(merge3('a', 'b', 'a').text, 'b');
  assert.equal(merge3('a', 'c', 'c').text, 'c');
});

test('merge3: same line changed differently keeps both, nothing lost', () => {
  const r = merge3('a\nb\nc', 'a\nB1\nc', 'a\nB2\nc');
  assert.equal(r.conflicts, 1);
  assert.equal(r.text, 'a\nB1\nB2\nc');
});

test('merge3: both append at the end', () => {
  const r = merge3('a', 'a\nmine', 'a\ntheirs');
  assert.equal(r.text, 'a\nmine\ntheirs');
});

test('merge3: inserts and deletes in different places', () => {
  const base = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
  const ours = ['0', '1', '2', '3', '4', '5', '6', '7', '8'].join('\n');  // insert at top
  const theirs = ['1', '2', '3', '5', '6', '7', '8', '9'].join('\n');     // delete 4, append 9
  assert.deepEqual(merge3(base, ours, theirs), { text: ['0', '1', '2', '3', '5', '6', '7', '8', '9'].join('\n'), conflicts: 0 });
});

test('merge3 fuzz: edits on separate halves always merge cleanly', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const mutate = (lines) => {
    const out = [...lines];
    for (let k = 0, edits = 1 + rnd(4); k < edits; k++) {
      const op = rnd(3), at = rnd(out.length + 1);
      if (op === 0) out.splice(at, 0, 'new' + rnd(1000));
      else if (op === 1 && out.length) out.splice(Math.min(at, out.length - 1), 1);
      else if (out.length) out[Math.min(at, out.length - 1)] = 'chg' + rnd(1000);
    }
    return out;
  };
  for (let t = 0; t < 300; t++) {
    const top = Array.from({ length: 1 + rnd(8) }, (_, i) => 'top' + i);
    const bottom = Array.from({ length: 1 + rnd(8) }, (_, i) => 'bot' + i);
    const anchor = ['==a==', '==b==', '==c=='];
    const base = [...top, ...anchor, ...bottom].join('\n');
    const oursTop = mutate(top), theirsBottom = mutate(bottom);
    const r = merge3(base, [...oursTop, ...anchor, ...bottom].join('\n'), [...top, ...anchor, ...theirsBottom].join('\n'));
    assert.equal(r.text, [...oursTop, ...anchor, ...theirsBottom].join('\n'), `case ${t}`);
    assert.equal(r.conflicts, 0);
  }
});

test('noteSnippet drops images and keeps link text', () => {
  assert.equal(noteSnippet('Trip\n![lake](/files/x/lake.png) see [the plan](/files/y/plan.pdf)'), 'see the plan');
});

test('merge3: edits to neighbouring lines merge cleanly', () => {
  const base = 'Sync test\nline one\nline two';
  const r = merge3(base, 'Sync test, renamed\nline one\nline two', 'Sync test\nline ONE\nline two');
  assert.deepEqual(r, { text: 'Sync test, renamed\nline ONE\nline two', conflicts: 0 });
});

test('merge3 fuzz: never loses a line that only one side added', () => {
  let seed = 11;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let t = 0; t < 300; t++) {
    const base = Array.from({ length: 2 + rnd(8) }, (_, i) => 'b' + i);
    const ours = [...base], theirs = [...base];
    ours.splice(rnd(ours.length + 1), 0, 'OURS' + t);
    theirs.splice(rnd(theirs.length + 1), 0, 'THEIRS' + t);
    if (rnd(2)) ours[rnd(ours.length)] = 'oc' + t;
    if (rnd(2)) theirs[rnd(theirs.length)] = 'tc' + t;
    const out = merge3(base.join('\n'), ours.join('\n'), theirs.join('\n')).text.split('\n');
    for (const line of [...ours, ...theirs].filter((l) => !base.includes(l))) assert.ok(out.includes(line), `case ${t}: lost ${line}`);
  }
});

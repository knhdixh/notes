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

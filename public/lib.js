// Shared by the browser and the Worker: words, days, tags and the streak engine.

export const DEFAULT_GOAL = 750;
// Writing before this hour still counts for the previous day (late-night sessions).
export const DAY_CUTOFF_HOUR = 3;
export const MAX_FREEZES = 2;
export const FREEZE_EVERY = 7;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function wordCount(text) {
  if (!text) return 0;
  // Images and link targets aren't words.
  const m = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\]\([^)]*\)/g, '] ').match(WORD);
  return m ? m.length : 0;
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// The diary day ('YYYY-MM-DD') that the instant `now` belongs to in `tz`.
export function localDay(now, tz, cutoffHour = DAY_CUTOFF_HOUR) {
  const shifted = new Date(now - cutoffHour * 3600e3);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

export function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Bear-style tags: #tag, #nested/tag. Ignores headings ("# Title"), code and URLs' fragments.
export function extractTags(text) {
  if (!text) return [];
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const tags = new Set();
  for (const m of clean.matchAll(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu)) {
    const tag = m[2].replace(/\/+$/, '').toLowerCase();
    if (tag && !/^\d+$/.test(tag)) tags.add(tag);
  }
  return [...tags].sort();
}

// First non-empty line, without markdown markers.
export function noteTitle(text) {
  const line = (text || '').split('\n').find((l) => l.trim()) || '';
  return line.replace(/^\s*#{1,6}\s+/, '').replace(/[*_`~]/g, '').trim().slice(0, 200);
}

export function noteSnippet(text) {
  const lines = (text || '').split('\n');
  const first = lines.findIndex((l) => l.trim());
  return lines.slice(first + 1).join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[[ xX]\]/g, '')
    .replace(/[#*_`>~\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/*
 * Streak engine.
 * days: [{ day, words, completed }] where `completed` means the goal was reached on that day itself.
 * Rules:
 *  - each completed day extends the streak
 *  - every 7th completed day of a run earns a freeze (banked, at most 2)
 *  - a missed day spends a freeze if the streak is alive, otherwise the streak resets
 *  - today never breaks the streak while it's still in progress
 */
export function computeStreak(days, today, goal = DEFAULT_GOAL) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const status = {};
  let current = 0, longest = 0, freezes = 0, run = 0, totalWords = 0, completedDays = 0;
  for (const d of days) totalWords += d.words || 0;

  const first = days.map((d) => d.day).filter((d) => d <= today).sort()[0];
  if (first) {
    for (let d = first; d <= today; d = addDays(d, 1)) {
      const e = byDay.get(d);
      if (e && e.completed) {
        current++; run++; completedDays++;
        if (run % FREEZE_EVERY === 0 && freezes < MAX_FREEZES) freezes++;
        longest = Math.max(longest, current);
        status[d] = 'done';
      } else if (d === today) {
        status[d] = e && e.words ? 'partial' : 'today';
      } else if (current > 0 && freezes > 0) {
        freezes--;
        status[d] = 'frozen';
      } else {
        current = 0; run = 0;
        status[d] = e && e.words ? 'partial' : 'missed';
      }
    }
  }

  const todayEntry = byDay.get(today);
  const todayWords = todayEntry ? todayEntry.words : 0;
  const todayDone = !!(todayEntry && todayEntry.completed);
  return {
    current, longest, freezes, totalWords, completedDays,
    todayWords, todayDone, goal,
    toGo: Math.max(0, goal - todayWords),
    atRisk: current > 0 && !todayDone,
    nextFreezeIn: freezes >= MAX_FREEZES ? null : FREEZE_EVERY - (run % FREEZE_EVERY),
    status,
  };
}

/* ---------- files ---------- */

export const FILE_URL = /\/files\/([0-9a-f-]{36})(?:\/[^)\s]*)?/g;

export function extractFileIds(text) {
  return [...new Set([...(text || '').matchAll(FILE_URL)].map((m) => m[1]))].sort();
}

/* ---------- three-way merge (two devices editing the same text) ---------- */

// Changed line ranges between a and b: [{ aStart, aEnd, bStart, bEnd }].
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  if (!n && !m) return [];
  if (!n || !m || n * m > 4e6) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];
  // LCS table, then walk it to emit change hunks.
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, open = null;
  const close = () => { if (open) { open.aEnd = pre + i; open.bEnd = pre + j; hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    if (!open) open = { aStart: pre + i, bStart: pre + j };
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) j++; else i++;
  }
  close();
  return hunks;
}

// Merges two edits of `base`. Where both sides changed the same lines differently,
// keeps both (ours, then theirs) so nothing is lost, and counts a conflict.
export function merge3(base, ours, theirs) {
  if (ours === theirs || theirs === base) return { text: ours, conflicts: 0 };
  if (ours === base) return { text: theirs, conflicts: 0 };
  const O = base.split('\n'), X = ours.split('\n'), T = theirs.split('\n');
  const hunks = [
    ...diffLines(O, X).map((h) => ({ ...h, side: 'ours' })),
    ...diffLines(O, T).map((h) => ({ ...h, side: 'theirs' })),
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd);

  // Hunks overlap when they share base lines, or when one is a pure insertion at the point the
  // other touches (then the order is ambiguous). Edits to neighbouring lines stay separate.
  const groups = [];
  const isIns = (h) => h.aStart === h.aEnd;
  for (const h of hunks) {
    const g = groups[groups.length - 1];
    const touches = g && h.aStart === g.hi && (isIns(h) || g.hunks.some((x) => isIns(x) && x.aStart === g.hi));
    if (g && (h.aStart < g.hi || touches)) { g.hi = Math.max(g.hi, h.aEnd); g.hunks.push(h); }
    else groups.push({ lo: h.aStart, hi: h.aEnd, hunks: [h] });
  }
  // Where base range [lo, hi) lands in one side, given that side's hunks.
  // Line offset a side has accumulated before base line `lo` (hunks before a group all start before it).
  const shift = (side, lo) => hunks.filter((h) => h.side === side && h.aStart < lo)
    .reduce((d, h) => d + (h.bEnd - h.bStart) - (h.aEnd - h.aStart), 0);
  const slice = (side, lines, g) => {
    const d0 = shift(side, g.lo);
    const d1 = d0 + g.hunks.filter((h) => h.side === side).reduce((d, h) => d + (h.bEnd - h.bStart) - (h.aEnd - h.aStart), 0);
    return lines.slice(g.lo + d0, g.hi + d1);
  };

  const out = [];
  let conflicts = 0, at = 0;
  for (const g of groups) {
    out.push(...O.slice(at, g.lo));
    const sides = new Set(g.hunks.map((h) => h.side));
    const mine = slice('ours', X, g), theirsPart = slice('theirs', T, g);
    if (!sides.has('theirs')) out.push(...mine);
    else if (!sides.has('ours')) out.push(...theirsPart);
    else if (mine.join('\n') === theirsPart.join('\n')) out.push(...mine);
    else { out.push(...mine, ...theirsPart); conflicts++; }
    at = g.hi;
  }
  out.push(...O.slice(at));
  return { text: out.join('\n'), conflicts };
}

// Shared by the browser and the Worker: words, days, tags and the streak engine.

export const DEFAULT_GOAL = 750;
// Writing before this hour still counts for the previous day (late-night sessions).
export const DAY_CUTOFF_HOUR = 3;
export const MAX_FREEZES = 2;
export const FREEZE_EVERY = 7;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function wordCount(text) {
  if (!text) return 0;
  const m = text.match(WORD);
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
  return lines.slice(first + 1).join(' ').replace(/\[[ xX]\]/g, '')
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

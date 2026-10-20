// Small helpers shared by the frontend modules.

export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// JSON API call. Errors carry `status` and the response `data` (409s include the server copy).
export async function api(path, { method = 'GET', body, raw, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: raw ? headers : body ? { 'Content-Type': 'application/json' } : {},
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    // Offline, or the Access session expired (its login redirect is cross-origin).
    throw new Error(navigator.onLine ? 'Connection lost. Text is kept on this device; reload to sign in again.' : 'Offline. Retrying.');
  }
  if (res.redirected || res.status === 401) {
    location.reload();
    throw new Error('Signed out.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('notes:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('notes:' + k, JSON.stringify(v)); } catch { /* private mode or full */ } },
  del(k) { try { localStorage.removeItem('notes:' + k); } catch { /* ignore */ } },
};

export const n = (x) => Number(x || 0).toLocaleString('en-GB');
export const plural = (x, w) => `${n(x)} ${w}${x === 1 ? '' : 's'}`;

export const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
};
export const fmtDay = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const fmtShortDay = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Loose "type a few letters" match: substring first, then letters in order.
export function fuzzy(query, text) {
  const q = query.toLowerCase().trim(), t = text.toLowerCase();
  if (!q) return 1;
  const i = t.indexOf(q);
  if (i >= 0) return 200 - i - (t.length - q.length) * 0.1 + (i === 0 || /\W/.test(t[i - 1]) ? 50 : 0);
  let ti = 0, gaps = 0;
  for (const c of q) {
    if (c === ' ') continue;
    const j = t.indexOf(c, ti);
    if (j < 0) return -1;
    gaps += j - ti;
    ti = j + 1;
  }
  return 100 - gaps;
}

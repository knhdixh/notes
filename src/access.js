// Verifies the Cloudflare Access JWT so the API stays private even if Access were misconfigured.
// Env: ACCESS_TEAM_DOMAIN (e.g. team.cloudflareaccess.com), ACCESS_AUD, OWNER_EMAIL (secret).
// Local dev only: DEV_LOGIN=1 in .dev.vars skips the check.

let jwksCache = { at: 0, keys: null, domain: null };

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function getKeys(domain, fetcher) {
  if (jwksCache.keys && jwksCache.domain === domain && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const res = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('JWKS fetch failed: ' + res.status);
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys, domain };
  return keys;
}

export function resetJwksCache() { jwksCache = { at: 0, keys: null, domain: null }; }

// Returns the verified email, or null.
export async function verifyAccess(request, env, fetcher = fetch) {
  if (env.DEV_LOGIN === '1') return env.OWNER_EMAIL || 'dev@localhost';
  const { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: aud, OWNER_EMAIL: owner } = env;
  if (!domain || !aud || !owner) return null;

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256') return null;

  const keys = await getKeys(domain, fetcher);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${domain}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (String(payload.email || '').toLowerCase() !== owner.toLowerCase()) return null;
  return payload.email;
}

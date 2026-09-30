/**
 * Shared helpers for every route: responses, the partner API client, CORS for local
 * testing, and the small amount of crypto the claim flow needs.
 */

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

export function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function cap(v, max) {
  return String(v).slice(0, max);
}

/* ── partner API ─────────────────────────────────────────────────────────── */

export function apiBase(env) {
  return (env.EXONOME_API_BASE || 'https://partners.exono.me').replace(/\/+$/, '');
}

export async function upstream(env, method, path, payload) {
  const init = {
    method,
    headers: { 'X-Api-Key': env.EXONOME_API_KEY, Accept: 'application/json' },
  };
  if (payload !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }

  const res = await fetch(apiBase(env) + path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) console.error(`${method} ${path} -> ${res.status}`, JSON.stringify(body));
  return { ok: res.ok && body?.success !== false, status: res.status, body };
}

// The API serialises with ASP.NET's default camelCase policy, which turns "OFID" into "ofid"
// and "EmailInvited" into "emailInvited". Read either spelling so a policy change on the API
// side cannot silently blank a field here.
export function field(obj, name) {
  if (!obj) return undefined;
  if (name in obj) return obj[name];
  const camel = name.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (m) => m.toLowerCase());
  if (camel in obj) return obj[camel];
  const lower = name.toLowerCase();
  return lower in obj ? obj[lower] : undefined;
}

// 4xx from the API is usually a real validation message worth showing; 5xx is not.
export function relay(result, fallback) {
  const msg = result.status >= 400 && result.status < 500 && result.body?.error
    ? String(result.body.error)
    : fallback;
  return json({ success: false, error: msg }, result.status >= 500 ? 502 : 400);
}

/* ── request context ─────────────────────────────────────────────────────── */

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'local';
}

// Origins allowed to call the API from another origin. Empty in production: the pages and
// the Worker share exonopeeps.com. Locally the page is served by a static server on
// :5500 and the Worker by `wrangler dev` on :8787, which the browser treats as cross-origin.
export function devOrigins(env) {
  return str(env.DEV_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

export function isDev(env) {
  return env.DEV === '1';
}

// Every state-changing claim call must come from our own page. SameSite=Lax already keeps
// the session cookie off cross-site POSTs; this also refuses same-site pages we don't own.
export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  if (env.SITE_ORIGIN && origin === env.SITE_ORIGIN) return true;
  return devOrigins(env).includes(origin);
}

export function withCors(request, env, response) {
  const origin = request.headers.get('Origin');
  if (!origin || !devOrigins(env).includes(origin)) return response;
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Access-Control-Allow-Credentials', 'true');
  out.headers.append('Vary', 'Origin');
  return out;
}

export function preflight(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !devOrigins(env).includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/* ── crypto ──────────────────────────────────────────────────────────────── */

const enc = new TextEncoder();
const keyCache = new Map();

async function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmac(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return b64url(new Uint8Array(sig));
}

// Constant-time for equal lengths; lengths themselves are not secret here.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Uniform over 000000-999999: rejection sampling avoids the modulo bias of a plain `% 1e6`.
export function sixDigits() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1e6) * 1e6;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 1e6).padStart(6, '0');
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlText(text) {
  return b64url(enc.encode(text));
}

export function fromB64urlText(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/* ── content rules ───────────────────────────────────────────────────────── */

// Jonathan's rule (2026-09-30): no URLs in any text field except the one link field. This is
// a copy of the Partner API's own pattern (Services/UrlDetector.cs, v3.2.0) so the participant
// sees the error on the right field before the API would refuse the save. Keep them in step.
// A scheme, "www.", or a bare domain with a known TLD — which also catches an email address.
const TLDS =
  'com|net|org|edu|gov|io|co|ai|me|app|dev|us|uk|ca|au|nz|de|fr|eu|biz|info|xyz|site|' +
  'online|store|shop|tech|ly|gg|tv|fm|sh|vc|cloud|digital|agency|club|live|link|page|' +
  'ventures|capital|group|global|world|studio|design|media|network|solutions|services|' +
  'company|business|consulting|partners|work|works|events|community|social|email';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const URLISH = new RegExp(
  `(?:\\b[a-z][a-z0-9+.-]*://)|(?:\\bwww\\.)|(?:\\b${LABEL}(?:\\.${LABEL})*\\.(?:${TLDS})(?![a-z0-9-]))`,
  'i',
);

export function containsUrl(text) {
  return URLISH.test(text || '');
}

export function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

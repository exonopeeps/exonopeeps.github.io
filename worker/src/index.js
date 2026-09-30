/**
 * ExonoPeeps — API Worker
 *
 * Sits on https://exonopeeps.com/api/* (and www.) in front of the Exonome v3 Partner API.
 *
 * Why this exists: the site is static (GitHub Pages), so anything the page holds is
 * readable by anyone who opens DevTools. The partner API key, SPID, MOID and the session
 * secret live here as Worker secrets instead, and the browser only ever talks to our own
 * origin.
 *
 *   /api/participate      walk-up lead capture              (participate.js)
 *   /api/claim/*          claim and enrich an existing card  (claim.js)
 *   /api/wall             live cards for the big screen      (wall.js)
 */
import { json, withCors, preflight } from './lib.js';
import { participate } from './participate.js';
import { claim } from './claim.js';
import { wall } from './wall.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return preflight(request, env);

    let response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      // Never surface an upstream stack trace to the page.
      console.error('request failed:', err && err.stack ? err.stack : String(err));
      response = json({ success: false, error: 'Something went wrong on our side. Please try again.' }, 502);
    }
    return withCors(request, env, response);
  },
};

function route(request, env, ctx) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');

  if (path === '/api/participate') return participate(request, env);
  if (path === '/api/wall') return wall(request, env, ctx);

  const m = path.match(/^\/api\/claim\/(start|verify|me|save|photo)$/);
  if (m) return claim(request, env, ctx, m[1]);

  return json({ success: false, error: 'Not found.' }, 404);
}

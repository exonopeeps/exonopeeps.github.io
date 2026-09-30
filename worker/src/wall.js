/**
 * GET /api/wall — every live card in the claim market, newest change first, for the
 * big screen and the claim page's counter.
 *
 * Public by design: it carries only what the market page already shows. No emails.
 * Cached at the edge for a few seconds so a wall polling every 5s, plus every phone on
 * the claim page, costs the Partner API one call per window rather than one per viewer.
 */
import { json, str, upstream, field } from './lib.js';
import { claimMappings, claimMoid, pageUrl, photoUrl, LIVE } from './claim.js';

const CACHE_S = 5;

export async function wall(request, env, ctx) {
  if (request.method !== 'GET') {
    return json({ success: false, error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }

  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + '/api/wall', { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const moid = claimMoid(env);
  const [offerings, mappings, claims] = await Promise.all([
    upstream(env, 'GET', `/api/offerings/by-moid/${moid}?status=4`),
    claimMappings(env),
    env.DB
      ? env.DB.prepare('SELECT ofid, claimed_at, updated_at, photo_url, photo_at, accepted FROM claims').all()
      : Promise.resolve({ results: [] }),
  ]);
  if (!offerings.ok) return json({ success: false, error: 'The Exchange is unavailable.' }, 502);

  const emidByOfid = new Map(mappings.map((m) => [m.ofid, m.emid]));
  // "N of M claimed": M is every card someone can actually claim — live (EntityMapping Status 4)
  // AND carrying an invited email (EmailInvited). N is those whose owner accepted being
  // discoverable. A declined card is paused, so it is in neither; a card with no email on file
  // can't be claimed, so it isn't counted either.
  const claimable = new Set(mappings.filter((m) => m.status === LIVE && m.email).map((m) => m.ofid));
  const claimByOfid = new Map((claims.results || []).map((c) => [c.ofid, c]));

  const cards = (offerings.body.data || []).map((o) => {
    const ofid = field(o, 'OFID');
    const c = claimByOfid.get(ofid);
    return {
      ofid,
      name: str(field(o, 'OfferingName')) || str(field(o, 'TargetPersonName')),
      category: str(field(o, 'OfferingCategory')),
      description: str(field(o, 'OfferingDescription')),
      tags: str(field(o, 'Tags')).split(';').map((t) => t.trim()).filter(Boolean),
      photoUrl: photoUrl(env, ofid, c),
      pageUrl: pageUrl(env, emidByOfid.get(ofid)),
      claimed: !!c?.accepted,
      updatedAt: c ? c.updated_at : null,
    };
  });

  // Freshly touched cards first, so the wall can feature them; the rest in a stable order.
  cards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.ofid - b.ofid);

  const claimed = cards.filter((c) => c.claimed && claimable.has(c.ofid)).length;
  const body = {
    success: true,
    data: {
      event: env.EVENT_NAME || 'The Exchange',
      summary: { total: claimable.size, claimed, live: cards.length },
      cards,
      at: Date.now(),
    },
  };

  const res = json(body, 200, { 'Cache-Control': `public, max-age=${CACHE_S}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

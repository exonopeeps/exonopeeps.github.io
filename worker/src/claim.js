/**
 * /api/claim/* — a participant proves they own the email on file for their card, then
 * enriches that one card.
 *
 *   POST /api/claim/start    {email}         -> emails a 6-digit code (same reply either way)
 *   POST /api/claim/verify   {email, code}   -> sets the session cookie, returns the card
 *   GET  /api/claim/me                       -> the confirmed participant's card
 *   POST /api/claim/save     {fields}        -> updates allowed fields via the Partner API
 *   POST /api/claim/photo    multipart photo -> replaces the hero image
 *
 * Who owns which card is read from the platform on every confirmation: the card's EntityMapping
 * row in the claim market carries the participant's email in EmailInvited. The Worker keeps
 * only what the platform has no place for — codes, the claim record and the change log — in
 * D1, and stores emails there only as keyed hashes.
 *
 * The OFID a request may touch comes from the signed session, never from the request body.
 * That is the guard that matters: the partner key itself can write to any offering the brand
 * owns.
 */
import {
  json, str, apiBase, upstream, field, clientIp, isDev, originAllowed,
  hmac, safeEqual, sixDigits, b64urlText, fromB64urlText, containsUrl, isEmail,
} from './lib.js';

const CODE_TTL_MS      = 10 * 60 * 1000;
const SESSION_TTL_S    = 12 * 60 * 60;       // an event day
const MAX_ATTEMPTS     = 5;                  // wrong guesses per code
const PER_EMAIL        = { n: 3,  ms: 15 * 60 * 1000 };
const PER_IP           = { n: 30, ms: 60 * 60 * 1000 };
const MAPPING_TTL_MS   = 60 * 1000;
const MAX_PHOTO_BYTES  = 8 * 1024 * 1024;
const COOKIE           = 'xp_claim';
const LIVE             = 4;                  // EntityMapping.Status: listing is live in the market
const PAUSED           = 6;                  // EntityMapping.Status: paused (ML0 / Admin code)

// Offering column caps (Core-V3 Offering [MaxLength]) and the Partner API details contract.
const LIMITS = { description: 600, tags: 100, email: 50 };

const GENERIC_SENT = "If you're on the list, a code is on its way. Check your inbox.";
const BAD_CODE     = "That code didn't work, or it has expired. Check it, or send a new one.";

export async function claim(request, env, ctx, action) {
  const missing = ['EXONOME_API_KEY', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (!env.DB) missing.push('DB (D1 binding)');
  if (!claimMoid(env)) missing.push('CLAIM_MOID');
  if (!claimSpid(env)) missing.push('CLAIM_SPID');   // the event = its exchange AND its seller
  if (missing.length) {
    console.error('claim: missing binding(s):', missing.join(', '));
    return json({ success: false, error: 'Claiming is not switched on yet.' }, 500);
  }

  const method = action === 'me' ? 'GET' : 'POST';
  if (request.method !== method) {
    return json({ success: false, error: 'Method not allowed.' }, 405, { Allow: method });
  }
  if (method === 'POST' && !originAllowed(request, env)) {
    return json({ success: false, error: 'Please use the claim page.' }, 403);
  }

  switch (action) {
    case 'start':  return start(request, env, ctx);
    case 'verify': return verify(request, env);
    case 'me':     return me(request, env);
    case 'save':   return save(request, env, ctx);
    case 'photo':  return photo(request, env);
    default:       return json({ success: false, error: 'Not found.' }, 404);
  }
}

/* ── start: email in, code out ───────────────────────────────────────────── */

async function start(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  if (!isEmail(email) || email.length > LIMITS.email) {
    return json({ success: false, error: "That doesn't look like an email address." }, 400);
  }

  const devEcho = isDev(env) && env.DEV_ECHO_CODE === '1';
  if (!canSendEmail(env) && !devEcho) {
    // Checked before the lookup so the answer is the same for every email.
    console.error('claim: no email sender (EMAIL binding or SENDGRID_API_KEY)');
    return json({ success: false, error: 'Email is not set up yet. Please find an organiser.' }, 500);
  }

  const now = Date.now();
  const ip = clientIp(request);

  const ipCount = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM codes WHERE ip = ? AND created_at > ?',
  ).bind(ip, now - PER_IP.ms).first('n');
  if (ipCount >= PER_IP.n) {
    return json({ success: false, error: 'Too many tries from this connection. Wait a few minutes.' }, 429);
  }

  const emailKey = await keyFor(env, email);
  const emailCount = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM codes WHERE email_key = ? AND created_at > ?',
  ).bind(emailKey, now - PER_EMAIL.ms).first('n');
  if (emailCount >= PER_EMAIL.n) {
    // Same reply as success: a different one would say this email is being used.
    console.warn('claim: per-email limit reached');
    return json({ success: true, data: { message: GENERIC_SENT } });
  }

  const card = await findCard(env, email);
  const code = sixDigits();
  const codeHash = card ? await hmac(env.SESSION_SECRET, `code:${emailKey}:${code}`) : null;

  await env.DB.prepare(
    `INSERT INTO codes (email_key, ofid, emid, code_hash, created_at, expires_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(emailKey, card?.ofid ?? null, card?.emid ?? null, codeHash, now, now + CODE_TTL_MS, ip).run();

  // Sending runs after the response, so a found email and an unknown one answer equally fast.
  const mail = card ? codeEmail(env, email, code, card) : notListedEmail(env);
  if (canSendEmail(env)) ctx.waitUntil(sendEmail(env, email, mail));

  const data = { message: GENERIC_SENT };
  if (devEcho) {
    console.log(`[dev] ${email}: ${card ? `OFID ${card.ofid}, code ${code}` : 'not on the list'}`);
    data.dev = { found: !!card, code: card ? code : null };
  }
  return json({ success: true, data });
}

/* ── verify: code in, session out ────────────────────────────────────────── */

async function verify(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = str(body.code).replace(/\s+/g, '');
  if (!isEmail(email) || !/^\d{6}$/.test(code)) {
    return json({ success: false, error: BAD_CODE }, 400);
  }

  const now = Date.now();
  const emailKey = await keyFor(env, email);
  const row = await env.DB.prepare(
    `SELECT id, ofid, emid, code_hash, attempts FROM codes
     WHERE email_key = ? AND used_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(emailKey, now).first();

  if (!row || row.attempts >= MAX_ATTEMPTS) return json({ success: false, error: BAD_CODE }, 400);

  // Count the attempt before comparing, so parallel guesses cannot all slip under the cap.
  await env.DB.prepare('UPDATE codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();

  const expected = await hmac(env.SESSION_SECRET, `code:${emailKey}:${code}`);
  if (!row.code_hash || !safeEqual(expected, row.code_hash)) {
    return json({ success: false, error: BAD_CODE }, 400);
  }

  // Single use, and any other code still outstanding for this email dies with it.
  await env.DB.prepare('UPDATE codes SET used_at = ? WHERE email_key = ? AND used_at IS NULL')
    .bind(now, emailKey).run();

  await env.DB.prepare(
    `INSERT INTO claims (ofid, emid, email_key, claimed_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ofid) DO UPDATE SET email_key = excluded.email_key, emid = excluded.emid,
                                     last_login_at = excluded.last_login_at`,
  ).bind(row.ofid, row.emid, emailKey, now, now, now).run();
  await audit(env, request, row.ofid, emailKey, 'verify', null, null);

  const session = { o: row.ofid, m: row.emid, e: email, x: Math.floor(now / 1000) + SESSION_TTL_S };
  const card = await loadCard(env, session);
  if (!card.ok) return card.response;

  return json({ success: true, data: card.data }, 200, { 'Set-Cookie': await sessionCookie(env, session) });
}

/* ── me ──────────────────────────────────────────────────────────────────── */

async function me(request, env) {
  const session = await readSession(request, env);
  if (!session) return json({ success: false, error: 'Enter your email to open your card.' }, 401);

  const card = await loadCard(env, session);
  return card.ok ? json({ success: true, data: card.data }) : card.response;
}

/* ── save ────────────────────────────────────────────────────────────────── */

async function save(request, env, ctx) {
  const session = await readSession(request, env);
  if (!session) return json({ success: false, error: 'That took a while. Enter your email again to keep going.' }, 401);
  if (env.FREEZE_EDITS === '1') {
    return json({ success: false, error: 'Editing is paused for a moment. Try again shortly.' }, 423);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ success: false, error: 'We could not read that.' }, 400);
  }

  const current = await upstream(env, 'GET', `/api/offerings/${session.o}`);
  if (!current.ok) return quiet(current, 'We could not load your card. Try again.');
  const o = current.body.data;

  const vocab = tagVocab(env);
  const before = {};
  const patch = {};
  const fail = (fieldName, error) => json({ success: false, error, field: fieldName }, 400);

  if ('description' in body) {
    const v = str(body.description);
    const was = str(field(o, 'OfferingDescription'));
    if (v !== was) {
      if (!v) return fail('description', 'Tell people what you offer.');
      if (v.length > LIMITS.description) return fail('description', `Keep this under ${LIMITS.description} characters.`);
      if (containsUrl(v)) return fail('description', 'Leave web addresses and emails out of this.');
      before.OfferingDescription = was;
      patch.OfferingDescription = v;
    }
  }

  // Category: one pick from the exchange's list (CATEGORIES = exchange 2322's allowlist). The card's
  // current value is always allowed back. The Partner API checks it against the allowlist again.
  if ('category' in body && categoryChoices(env, o).length) {
    const v = str(body.category);
    const was = str(field(o, 'OfferingCategory'));
    if (v !== was) {
      if (!categoryChoices(env, o).includes(v)) return fail('category', 'Pick one of the categories.');
      before.OfferingCategory = was;
      patch.OfferingCategory = v;
    }
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags)) return fail('tags', 'We could not read those tags.');
    const was = splitTags(field(o, 'Tags'));
    const allowed = new Set([...vocab, ...was]);   // tags already on the card stay valid
    const next = [...new Set(body.tags.map(normTag).filter(Boolean))];
    // Tags not on the list (or already on the card) are their own, typed in "+ Other".
    const custom = customTags(env);
    const mine = next.filter((t) => !allowed.has(t));
    if (mine.length && !custom) return fail('tags', `"${mine[0]}" isn't one of the options.`);
    if (custom && mine.length > custom.max) return fail('tags', `Add up to ${custom.max} of your own.`);
    for (const t of mine) {
      if (t.length > custom.len) return fail('tags', `Keep "${t.slice(0, 20)}…" under ${custom.len} characters.`);
      if (!OWN_TAG.test(t) || containsUrl(t)) return fail('tags', 'Your own tags: letters, numbers and spaces only, no web addresses.');
    }
    const joined = next.join(';');
    if (joined.length > LIMITS.tags) return fail('tags', 'That is too many. Pick fewer tags.');
    if (containsUrl(joined)) return fail('tags', 'Leave web addresses out of tags.');
    if (joined !== was.join(';')) {
      before.Tags = was.join(';');
      patch.Tags = joined;
    }
  }

  // The one decision a claim needs. Accepting makes the participant discoverable: introductions
  // go to their confirmed email and the card is live (Status 4). Declining pauses the card
  // (Status 6) and hands introductions back to the event inbox if they had been routed here.
  if (typeof body.leadsToMe !== 'boolean') {
    return fail('leadsToMe', 'Choose whether to be discoverable before saving.');
  }
  const accepted = body.leadsToMe;
  const target = str(field(o, 'TargetPersonEmail'));
  const isMine = target.toLowerCase() === session.e;
  if (accepted && !isMine) {
    before.TargetPersonEmail = target;
    patch.TargetPersonEmail = session.e;
  } else if (!accepted && isMine) {
    // Only hand leads back if they were routed to this participant; anything an organiser set
    // by hand is left alone.
    if (!env.EVENT_INBOX) return fail('leadsToMe', 'Ask an organiser to stop introductions coming to you.');
    before.TargetPersonEmail = target;
    patch.TargetPersonEmail = env.EVENT_INBOX;
  }

  let updated = o;
  if (Object.keys(patch).length) {
    const saved = await upstream(env, 'PATCH', `/api/offerings/${session.o}/details`, patch);
    if (!saved.ok) return quiet(saved, 'We could not save that. Try again in a moment.');
    updated = saved.body?.data || o;
  }

  // Live or paused, read fresh so a pause set elsewhere a minute ago is not missed.
  const mapping = (await claimMappings(env, { fresh: true })).find((m) => m.ofid === session.o);
  const wantStatus = accepted ? LIVE : PAUSED;
  let statusChange = null;
  if (mapping && mapping.status !== wantStatus) {
    const res = await upstream(env, 'PATCH', `/api/entity-mappings/${mapping.emid}/status`, { Status: wantStatus });
    if (!res.ok) return quiet(res, accepted ? 'We could not put your card live. Try again.' : 'We could not pause your card. Try again.');
    statusChange = { Status: [mapping.status, field(res.body?.data, 'Status') ?? wantStatus] };
    mappingCache.at = 0;
  }

  const now = Date.now();
  const emailKey = await keyFor(env, session.e);
  const wasAccepted = !!(await env.DB.prepare('SELECT accepted FROM claims WHERE ofid = ?').bind(session.o).first('accepted'));
  await env.DB.prepare('UPDATE claims SET updated_at = ?, accepted = ? WHERE ofid = ?')
    .bind(now, accepted ? 1 : 0, session.o).run();
  if (Object.keys(patch).length || statusChange) {
    await audit(env, request, session.o, emailKey, accepted ? 'accept' : 'decline',
      { ...before, ...(statusChange ? { Status: statusChange.Status[0] } : {}) },
      { ...patch, ...(statusChange ? { Status: statusChange.Status[1] } : {}) });
  }

  // The confirmation is the email they keep: it carries the page to come back to (the code email's
  // link dies in 10 minutes). Sent only when the decision changes — made discoverable, or paused —
  // never for an edit to the text, tags or photo. Ported from www.v3 claim-worker (2026-10-01).
  if ((accepted !== wasAccepted || statusChange) && canSendEmail(env)) {
    ctx.waitUntil(sendEmail(env, session.e, confirmedEmail(env, {
      email: session.e,
      name: str(field(updated, 'OfferingName')) || str(field(o, 'OfferingName')),
      live: accepted,
      cardUrl: pageUrl(env, session.m),
    })));
  }

  const card = await loadCard(env, session, updated);
  return card.ok ? json({ success: true, data: card.data }) : card.response;
}

/* ── photo ───────────────────────────────────────────────────────────────── */

async function photo(request, env) {
  const session = await readSession(request, env);
  if (!session) return json({ success: false, error: 'That took a while. Enter your email again to keep going.' }, 401);
  if (env.FREEZE_EDITS === '1') {
    return json({ success: false, error: 'Editing is paused for a moment. Try again shortly.' }, 423);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('photo');
  if (!file || typeof file !== 'object' || !file.size) {
    return json({ success: false, error: 'No photo came through. Try again.' }, 400);
  }
  if (file.size > MAX_PHOTO_BYTES) return json({ success: false, error: 'That photo is too large.' }, 400);
  if (!/^image\//i.test(file.type || '')) return json({ success: false, error: 'That file is not an image.' }, 400);

  const up = new FormData();
  up.append('file', file, 'photo.jpg');
  const res = await fetch(`${apiBase(env)}/api/offerings/${session.o}/photo`, {
    method: 'POST',
    headers: { 'X-Api-Key': env.EXONOME_API_KEY },
    body: up,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    console.error(`photo upload for OFID ${session.o} -> ${res.status}`, JSON.stringify(body));
    return quiet({ status: res.status, body }, 'We could not save that photo. Try another one.');
  }

  const url = field(body?.data, 'Url') || null;
  const now = Date.now();
  // "Remove photo": the page uploads its drawn initials tile so Exonome shows initials again. The
  // Partner API has no delete, and this keeps the card's image in step with what the page shows.
  // Here we forget the photo, so the page and the wall draw the initials themselves.
  const reset = form.get('reset') === '1';
  const was = await env.DB.prepare('SELECT photo_url FROM claims WHERE ofid = ?').bind(session.o).first('photo_url');
  await env.DB.prepare('UPDATE claims SET photo_url = ?, photo_at = ?, updated_at = ? WHERE ofid = ?')
    .bind(reset ? null : url, now, now, session.o).run();
  await audit(env, request, session.o, await keyFor(env, session.e), reset ? 'photo-reset' : 'photo',
    was ? { url: was } : null, { url });

  return json({ success: true, data: {
    photoUrl: photoUrl(env, session.o, { photo_url: reset ? null : url, photo_at: now }),
    hasPhoto: !reset,
  } });
}

/* ── the card, as the page sees it ───────────────────────────────────────── */

async function loadCard(env, session, offering = null) {
  let o = offering;
  if (!o) {
    const res = await upstream(env, 'GET', `/api/offerings/${session.o}`);
    if (!res.ok) return { ok: false, response: quiet(res, 'We could not load your card. Try again.') };
    o = res.body.data;
  }

  const claimRow = await env.DB.prepare('SELECT photo_url, photo_at, accepted FROM claims WHERE ofid = ?')
    .bind(session.o).first();
  const mapping = (await claimMappings(env)).find((m) => m.ofid === session.o);

  return {
    ok: true,
    data: {
      ofid: session.o,
      email: session.e,
      name: str(field(o, 'OfferingName')) || str(field(o, 'TargetPersonName')),
      person: str(field(o, 'TargetPersonName')),
      category: str(field(o, 'OfferingCategory')),
      ...(categoryChoices(env, o).length ? { categories: categoryChoices(env, o) } : {}),
      description: str(field(o, 'OfferingDescription')),
      tags: splitTags(field(o, 'Tags')),
      leadsToMe: str(field(o, 'TargetPersonEmail')).toLowerCase() === session.e,
      accepted: !!claimRow?.accepted,
      paused: mapping ? mapping.status !== LIVE : false,
      canHandBack: !!env.EVENT_INBOX,
      photoUrl: photoUrl(env, session.o, claimRow),
      hasPhoto: !!claimRow?.photo_url,        // a photo uploaded here, which Remove can undo
      pageUrl: pageUrl(env, session.m),
      marketUrl: marketUrl(env),            // "See everyone on the exchange" on the done screen
      vocab: tagVocab(env),
      ...(customTags(env) ? { custom: customTags(env) } : {}),   // "+ Other" limits for the page
      frozen: env.FREEZE_EDITS === '1',
    },
  };
}

/* ── lookup: which card does this email own? ─────────────────────────────── */

let mappingCache = { at: 0, moid: 0, list: null };

// All EntityMapping rows in the claim market. Shared with the wall, cached briefly: the
// list changes only when the POC workspace imports more guests.
export async function claimMappings(env, { fresh = false } = {}) {
  const moid = claimMoid(env);
  if (!fresh && mappingCache.list && mappingCache.moid === moid && Date.now() - mappingCache.at < MAPPING_TTL_MS) {
    return mappingCache.list;
  }
  const res = await upstream(env, 'GET', `/api/entity-mappings/by-moid/${moid}`);
  if (!res.ok) throw new Error(`entity-mappings/by-moid/${moid} -> ${res.status}`);

  // The event is its exchange (MOID) and its house seller (SPID) — nothing else. No OFID range:
  // guests are added continually, and a range silently shuts new cards out.
  const spid = claimSpid(env);
  const list = (res.body.data || [])
    .map((m) => ({
      emid: field(m, 'EMID'),
      spid: field(m, 'SPID'),
      ofid: field(m, 'OFID'),
      status: field(m, 'Status'),
      archived: field(m, 'IsArchived'),
      email: normEmail(field(m, 'EmailInvited')),
      name: str(field(m, 'SellerInvited')),
    }))
    // Live (4) or paused (6) cards can be claimed: a participant who declined — which pauses the
    // card — can come back and accept. Only live cards count toward "N of M" (see wall.js).
    // Held, pending and archived cards are out.
    .filter((m) => m.ofid > 0 && m.spid === spid && (m.status === LIVE || m.status === PAUSED) && !m.archived);

  mappingCache = { at: Date.now(), moid, list };
  return list;
}

async function findCard(env, email) {
  const hits = (await claimMappings(env)).filter((m) => m.email && m.email === email);
  if (hits.length > 1) {
    // One verified email = one card. Two cards on one email is a data problem; take the
    // oldest so the choice is at least stable, and say so in the log.
    console.warn(`claim: ${hits.length} cards share one email; using OFID ${Math.min(...hits.map((h) => h.ofid))}`);
    hits.sort((a, b) => a.ofid - b.ofid);
  }
  return hits[0] || null;
}

/* ── session cookie ──────────────────────────────────────────────────────── */

async function sessionCookie(env, session) {
  const payload = b64urlText(JSON.stringify(session));
  const sig = await hmac(env.SESSION_SECRET, `session:${payload}`);
  return cookie(env, `${payload}.${sig}`, SESSION_TTL_S);
}

function cookie(env, value, maxAge) {
  // Secure is dropped only for local testing over plain http.
  const secure = isDev(env) ? '' : '; Secure';
  return `${COOKIE}=${value}; Path=/api/claim; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function readSession(request, env) {
  const raw = (request.headers.get('Cookie') || '')
    .split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;

  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, `session:${payload}`);
  if (!safeEqual(expected, sig)) return null;

  try {
    const s = JSON.parse(fromB64urlText(payload));
    if (!s.o || !s.e || !s.x || s.x < Date.now() / 1000) return null;
    return s;
  } catch {
    return null;
  }
}

/* ── email ───────────────────────────────────────────────────────────────── */

// Each email carries both its own rendered copy and the data for the SendGrid dynamic template
// (worker/email/claim-code.html). With SENDGRID_TEMPLATE_ID set the template is used; otherwise,
// and for Cloudflare Email Service, the rendered copy below is sent as-is.
function templateData(env, extra) {
  const site = siteOrigin(env);
  return {
    event_name: env.EVENT_NAME || 'The Exchange',
    event_line: env.EVENT_LINE || '',
    site_url: site,
    ...extra,
  };
}

function codeEmail(env, email, code, card) {
  const event = env.EVENT_NAME || 'The Exchange';
  const link = `${siteOrigin(env)}/claim/#email=${encodeURIComponent(email)}&code=${code}`;
  return {
    data: templateData(env, {
      found: true,
      first_name: str(card?.name).split(/\s+/)[0] || '',
      code,
      code_display: `${code.slice(0, 3)} ${code.slice(3)}`,
      minutes: Math.round(CODE_TTL_MS / 60000),
      open_url: link,
    }),
    subject: `${subjectPrefix(env)}Action required: your code is ${code}`,
    text:
      `Your code is ${code}\n\n` +
      `Enter it on the page you just came from. It works for 10 minutes.\n\n` +
      `Or open this link on the same phone:\n${link}\n\n` +
      `If you didn't ask for this, ignore this email.`,
    html: shell(event, `
      <p style="margin:0 0 8px;font-size:15px;color:#5C6773">Your code</p>
      <p style="margin:0 0 20px;font-size:38px;font-weight:700;letter-spacing:.18em;color:#141C24">${code}</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#141C24">Enter it on the page you just came from. It works for 10 minutes.</p>
      <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#141C24;color:#fff;font-weight:700;font-size:15px;text-decoration:none">Or open your card</a></p>
      <p style="margin:0;font-size:13px;color:#5C6773">If you didn't ask for this, ignore this email.</p>`),
  };
}

// Registration is closed, so this note offers no sign-up: only "try the email you registered with".
function notListedEmail(env) {
  const event = env.EVENT_NAME || 'The Exchange';
  return {
    data: templateData(env, { found: false, first_name: '' }),
    subject: `${subjectPrefix(env)}Action required: we could not find your card`,
    text:
      `Someone (hopefully you) asked to open a card on ${event} with this email, ` +
      `but we don't have a card under it.\n\n` +
      `If you registered with a different email, try that one on the page you came from.\n\n` +
      `If you didn't ask for this, ignore this email.`,
    html: shell(event, `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#141C24">Someone (hopefully you) asked to open a card on ${event} with this email, but we don't have a card under it.</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#141C24">If you registered with a different email, try that one on the page you came from.</p>
      <p style="margin:0;font-size:13px;color:#5C6773">If you didn't ask for this, ignore this email.</p>`),
  };
}

// "Your card is live / paused": the email they keep. Same data names as www.v3's claim-confirmed
// template (d-672f8d4f…), which is event-neutral, so both claim sites share it.
function confirmedEmail(env, { email, name, live, cardUrl }) {
  const event = env.EVENT_NAME || 'The Exchange';
  const market = env.MARKET_NAME || str(env.EMAIL_SUBJECT_PREFIX) || event;
  const site = siteOrigin(env);
  const edit = `${site}/claim/`;
  const first = str(name).split(/\s+/)[0] || '';
  const hi = first ? `${esc(first)}, your card is ${live ? 'live' : 'paused'}.` : `Your card is ${live ? 'live' : 'paused'}.`;
  return {
    templateId: env.SENDGRID_CONFIRM_TEMPLATE_ID || null,
    data: templateData(env, {
      live,
      first_name: first,
      email: live ? email : '',
      edit_url: edit,
      card_url: live ? cardUrl || '' : '',
      market_name: market,
      site_host: site.replace(/^https?:\/\/(www\.)?/, ''),
      logo_url: env.EMAIL_LOGO_URL || '',
      logo_alt: 'ExonoPeeps',
    }),
    subject: `${subjectPrefix(env)}${live ? 'Your card is live' : 'Your card is paused'}`,
    text:
      (live
        ? `Your card is live. People at ${event} can find you now, and introductions go to ${email}.\n\n`
        : `Your card is paused. It's off ${event}, so no one can find or contact you there.\n\n`) +
      `${live ? 'Edit your card' : 'Put your card back'} any time (we'll send a code to confirm it's you):\n${edit}\n\n` +
      (live && cardUrl ? `See your card on ${market}:\n${cardUrl}\n\n` : '') +
      `Keep this email. Didn't do this? Open the link above to change it back.`,
    html: shell(event, `
      <h1 style="margin:0 0 10px;font-size:26px;line-height:1.15;color:#141C24">${hi}</h1>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#5C6773">${live
        ? `People at ${esc(event)} can find you now, and introductions are emailed to <b style="color:#141C24">${esc(email)}</b>.`
        : `It's off ${esc(event)}, so no one can find or contact you there. Nothing is lost: you can put it back any time.`}</p>
      <p style="margin:0 0 12px"><a href="${edit}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#141C24;color:#fff;font-weight:700;font-size:15px;text-decoration:none">${live ? 'Edit my card' : 'Put my card back'} &rarr;</a></p>
      <p style="margin:0;font-size:12px;color:#5C6773">Keep this email. The link always works: we'll send a code to confirm it's you.</p>
      ${live && cardUrl ? `<p style="margin:16px 0 0;font-size:14px"><a href="${cardUrl}" style="color:#0C889D;font-weight:600">See my card on ${esc(market)}</a></p>` : ''}`),
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shell(event, inner) {
  return `<!doctype html><html><body style="margin:0;background:#FDF8F2;font-family:Inter,Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #E7DED2;border-radius:16px">
<tr><td style="padding:28px">
<p style="margin:0 0 22px;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#0C889D">${event}</p>
${inner}
</td></tr></table></td></tr></table></body></html>`;
}

// Cloudflare Email Service (the EMAIL send_email binding) when it is bound; SendGrid otherwise.
// Either way a failure is logged, never shown: the page has already given its one reply.
async function sendEmail(env, to, mail) {
  if (env.EMAIL) {
    try {
      const res = await env.EMAIL.send({
        to,
        from: { email: fromAddress(env), name: env.EMAIL_FROM_NAME || 'ExonoPeeps' },
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      console.log(`email sent (${res?.messageId || 'no id'})`);
    } catch (err) {
      console.error(`cloudflare email failed: ${err?.code || ''} ${err?.message || String(err)}`);
    }
    return;
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendgridBody(env, to, mail)),
    });
    if (!res.ok) console.error(`sendgrid -> ${res.status}`, await res.text().catch(() => ''));
  } catch (err) {
    console.error('sendgrid threw:', String(err));
  }
}

function sendgridBody(env, to, mail) {
  const base = {
    from: { email: fromAddress(env), name: env.EMAIL_FROM_NAME || 'ExonoPeeps' },
    // Click tracking rewrites links, which would drop the #code fragment.
    tracking_settings: { click_tracking: { enable: false, enable_text: false } },
  };
  // Each email may name its own template (the confirmation does); otherwise the code template.
  // templateId === null means "no template configured for this email": send the built-in copy.
  const templateId = mail.templateId === undefined ? env.SENDGRID_TEMPLATE_ID : mail.templateId;
  if (templateId) {
    // The template owns both bodies (worker/email/*.html). The subject rides in the data so its
    // wording lives here: the template's Subject field is exactly {{{subject}}} (three braces).
    return {
      ...base,
      template_id: templateId,
      personalizations: [{ to: [{ email: to }], dynamic_template_data: { ...mail.data, subject: mail.subject } }],
    };
  }
  return {
    ...base,
    personalizations: [{ to: [{ email: to }] }],
    subject: mail.subject,
    content: [{ type: 'text/plain', value: mail.text }, { type: 'text/html', value: mail.html }],
  };
}

// "The Exchange 2026 - " in front of every subject, so the event is the first thing in the inbox.
function subjectPrefix(env) {
  const p = str(env.EMAIL_SUBJECT_PREFIX);
  return p ? `${p} - ` : '';
}

function fromAddress(env) {
  return env.EMAIL_FROM || 'hello@exonopeeps.com';
}

function canSendEmail(env) {
  return !!(env.EMAIL || env.SENDGRID_API_KEY);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Participants never see the Partner API's own error text (it names internal things like the
// brand or tenant). The Worker already validates every field, so an API refusal here is ours to
// fix, not theirs: log it in full, show a plain message.
function quiet(result, fallback) {
  console.error('claim: partner api refused', result.status, JSON.stringify(result.body));
  return json({ success: false, error: fallback }, result.status >= 500 ? 502 : 400);
}

async function audit(env, request, ofid, emailKey, action, before, after) {
  await env.DB.prepare(
    `INSERT INTO audit (ofid, email_key, action, before_json, after_json, at, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    ofid, emailKey, action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    Date.now(), clientIp(request), (request.headers.get('User-Agent') || '').slice(0, 200),
  ).run();
}

// Emails are stored in D1 only as keyed hashes: enough to rate-limit and match, not enough
// to rebuild the participant list if the database leaked.
function keyFor(env, email) {
  return hmac(env.SESSION_SECRET, `email:${email}`);
}

function normEmail(v) {
  return str(v).toLowerCase();
}

function normTag(v) {
  return str(v).toLowerCase().replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitTags(v) {
  return str(v).split(';').map(normTag).filter(Boolean);
}

export { LIVE };

// "+ Other": tags of their own on "What I'm looking for" (same rules as www.v3's tagCustom). Off unless
// TAG_CUSTOM = "1". Lowercase letters/digits, then also space & ' -; no URLs; inside the 100-char Tags.
const OWN_TAG = /^[a-z0-9][a-z0-9 &'-]*$/;
function customTags(env) {
  if (env.TAG_CUSTOM !== '1') return null;
  return {
    max: Math.min(Math.max(Number(env.TAG_CUSTOM_MAX) || 3, 1), 5),
    len: Math.min(Math.max(Number(env.TAG_CUSTOM_LEN) || 30, 3), 40),
  };
}

export function tagVocab(env) {
  return str(env.TAG_VOCAB).split(',').map(normTag).filter(Boolean);
}

export function claimSpid(env) {
  return Number(env.CLAIM_SPID || env.EXONOME_SPID);
}

export function claimMoid(env) {
  return Number(env.CLAIM_MOID || env.EXONOME_MOID);
}

// The categories a card may move to (same rule as www.v3): CATEGORIES split on ";" (names contain
// "&" and could contain commas), the card's own value first if the list lacks it. Empty = no
// question — CATEGORY_EDITS off or no list.
function categoryChoices(env, o) {
  if (env.CATEGORY_EDITS !== '1') return [];
  const list = [...new Set(str(env.CATEGORIES).split(';').map((c) => c.trim()).filter(Boolean))];
  if (!list.length) return [];
  const current = str(field(o, 'OfferingCategory'));
  return current && !list.includes(current) ? [current, ...list] : list;
}

// The exchange's market page. https only (as www.v3's events.js): it becomes a link on the page.
function marketUrl(env) {
  const u = str(env.MARKET_URL);
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null;
}

export function pageUrl(env, emid) {
  const base = (env.PUBLIC_BASE || 'https://connect.exono.me').replace(/\/+$/, '');
  return emid ? `${base}/IM/${emid}` : null;
}

// A photo uploaded here carries its own version so a screen already showing the old one
// fetches the new one. Cards never touched here fall back to the conventional hero path.
// The card's real image, as Exonome shows it: offerings/<OFID>/of_hero.png in the tenant's blob
// storage (IMAGE_BASE). The file name never changes, so every upload or removal here stamps a
// version on the address; screens already showing the old image then fetch the new one.
export function photoUrl(env, ofid, claimRow) {
  const base = str(env.IMAGE_BASE).replace(/\/+$/, '');
  const v = claimRow?.photo_at ? `?v=${claimRow.photo_at}` : '';
  if (base) return `${base}/${ofid}/of_hero.png${v}`;
  return claimRow?.photo_url ? `${claimRow.photo_url}${v}` : null;
}

function siteOrigin(env) {
  return (env.SITE_ORIGIN || 'https://exonopeeps.com').replace(/\/+$/, '');
}

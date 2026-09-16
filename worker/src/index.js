/**
 * ExonoPeeps — Participate proxy
 *
 * Sits on https://www.exonopeeps.com/api/* in front of the Exonome v3 Partner API.
 *
 * Why this exists: the site is static (GitHub Pages), so anything the page holds is
 * readable by anyone who opens DevTools. SPID, MOID and the partner API key live here
 * as Worker secrets instead, and the browser only ever talks to our own origin.
 *
 * One submit becomes up to three upstream calls:
 *   1. POST /api/offerings                 -> creates the lead Offering, returns OFID
 *   2. POST /api/offerings/{ofid}/photo    -> optional hero image
 *   3. POST /api/entity-mappings           -> bridges Offering <-> Seller <-> MarketOperator
 *
 * Secrets (wrangler secret put ...):
 *   EXONOME_API_KEY  partner key, needs scopes: offerings:write, entity-mappings:write
 *   EXONOME_SPID     seller the leads are attributed to
 *   EXONOME_MOID     market the leads land in
 * Vars (wrangler.toml):
 *   EXONOME_API_BASE, EVENT_NAME, LISTING_STATUS
 */

// Offering.Type. Canonical mapping is GlobalHelp.GetOfferingType in Core-V3: 6 == "lead".
const TYPE_LEAD = 6;

// A lead is an introduction, not a priced listing.
const RATE = 0;
const RATE_BASIS = 'lead';
const REFERRING_RELATIONSHIP = 'event';

// Field caps copied from the partner API's own [MaxLength] attributes. The page enforces
// the same numbers, but the page is not the authority — a crafted POST skips it entirely.
const LIMITS = {
  name: 50, email: 50, phone: 16, company: 100,
  offering: 50, category: 60, description: 600,
  specialty: 30, tags: 120, link: 300,
};

const REQUIRED = ['name', 'email', 'offering', 'category', 'description'];

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE = /^image\/(jpeg|png|webp|heic|heif)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/participate') {
      return json({ success: false, error: 'Not found.' }, 404);
    }
    if (request.method !== 'POST') {
      return json({ success: false, error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }

    try {
      return await handle(request, env);
    } catch (err) {
      // Never surface an upstream stack trace to the page.
      console.error('participate failed:', err && err.stack ? err.stack : String(err));
      return json({ success: false, error: 'Something went wrong on our side. Please try again.' }, 502);
    }
  },
};

async function handle(request, env) {
  const missing = ['EXONOME_API_KEY', 'EXONOME_SPID', 'EXONOME_MOID'].filter((k) => !env[k]);
  if (missing.length) {
    console.error('missing binding(s):', missing.join(', '));
    return json({ success: false, error: 'This form is not configured yet.' }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, error: 'We could not read that submission.' }, 400);
  }

  // Honeypot: the field is off-screen and unlabelled for real users, so anything in it
  // is a bot. Answer 200 with a plausible body — a bot that gets a 400 just retries.
  if (str(form.get('website'))) {
    console.log('honeypot tripped');
    return json({ success: true, data: { ofid: null } });
  }

  const f = {};
  for (const key of Object.keys(LIMITS)) f[key] = str(form.get(key));

  const errors = validate(f);
  if (errors.length) return json({ success: false, error: errors[0] }, 400);

  const base = (env.EXONOME_API_BASE || 'https://partners.exono.me').replace(/\/+$/, '');
  const moid = Number(env.EXONOME_MOID);
  const spid = Number(env.EXONOME_SPID);
  const status = env.LISTING_STATUS === undefined ? 4 : Number(env.LISTING_STATUS);

  // ── 1. Create the offering ────────────────────────────────────────────────
  const offering = {
    MOID: moid,
    TargetPersonName: f.name,
    TargetPersonEmail: f.email,
    OfferingName: f.offering,
    Type: TYPE_LEAD,
    OfferingDescription: f.description,
    OfferingCategory: f.category,
    Rate: RATE,
    RateBasis: RATE_BASIS,
    ReferringPersonName: cap(env.EVENT_NAME || 'The Exchange', LIMITS.name),
    ReferringRelationship: REFERRING_RELATIONSHIP,
  };
  if (f.phone) offering.TargetPersonPhone = f.phone;
  if (f.company) offering.OfferingDetails = f.company;
  if (f.specialty) offering.Specialty = f.specialty;
  if (f.tags) offering.Tags = f.tags;
  // Offering has no website column — VideoLink and DigitalDownloadLink are the only URL
  // fields on the entity, so a lead's link rides in VideoLink.
  if (f.link) offering.VideoLink = f.link;

  const created = await upstream(env, base, 'POST', '/api/offerings', offering);
  if (!created.ok) return relay(created, 'We could not add you to the Exchange.');

  const ofid = created.body?.data?.OFID ?? created.body?.data?.ofid;
  if (!ofid) {
    console.error('offering created but no OFID in response:', JSON.stringify(created.body));
    return json({ success: false, error: 'Something went wrong on our side. Please try again.' }, 502);
  }

  // ── 2. Bridge offering -> seller -> market ────────────────────────────────
  // Offering carries no SPID of its own; the EntityMapping is what attaches the seller and
  // the market, so without this the listing exists but belongs to nobody.
  //
  // This must also come BEFORE the photo: the API establishes ownership of an offering by
  // looking for an EntityMapping that belongs to the caller's brand, so an unmapped offering
  // has no owner to check and its photo endpoint answers 404.
  const mapped = await upstream(env, base, 'POST', '/api/entity-mappings', {
    OFID: ofid,
    SPID: spid,
    MOID: moid,
    Status: status,
  });

  if (!mapped.ok) {
    // The offering exists but is unattached. Log loudly with the OFID so it can be mapped
    // by hand rather than silently lost.
    console.error(`ORPHANED OFFERING ${ofid}: entity-mapping failed —`, JSON.stringify(mapped.body));
    return json({ success: false, error: 'We could not finish adding you. Please try again.' }, 502);
  }

  // ── 3. Photo (optional, best effort) ──────────────────────────────────────
  // A failed image must not fail the submission: the person is fully on the Exchange by this
  // point, and making them retype everything to retry a photo is worse than a listing with
  // no picture. Failures are logged with the OFID so the image can be added later.
  const photo = form.get('photo');
  if (photo && typeof photo === 'object' && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES) {
      console.warn(`photo skipped for OFID ${ofid}: ${photo.size} bytes exceeds limit`);
    } else if (!ALLOWED_IMAGE.test(photo.type || '')) {
      console.warn(`photo skipped for OFID ${ofid}: type ${photo.type}`);
    } else {
      try {
        const body = new FormData();
        body.append('file', photo, 'photo');
        const up = await fetch(`${base}/api/offerings/${ofid}/photo`, {
          method: 'POST',
          headers: { 'X-Api-Key': env.EXONOME_API_KEY },
          body,
        });
        if (!up.ok) console.warn(`photo upload for OFID ${ofid} returned ${up.status}`);
      } catch (err) {
        console.warn(`photo upload for OFID ${ofid} threw:`, String(err));
      }
    }
  }

  return json({ success: true, data: { ofid } });
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function validate(f) {
  const errors = [];

  for (const key of REQUIRED) {
    if (!f[key]) errors.push(`Please add your ${key === 'offering' ? 'headline' : key}.`);
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (f[key].length > max) errors.push(`Your ${key} is too long (max ${max} characters).`);
  }
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) {
    errors.push('That does not look like an email address.');
  }
  if (f.link && !/^https?:\/\/.+\..+/i.test(f.link)) {
    errors.push('Your link needs to start with https://');
  }
  return errors;
}

async function upstream(env, base, method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'X-Api-Key': env.EXONOME_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) console.error(`${method} ${path} -> ${res.status}`, JSON.stringify(body));
  return { ok: res.ok && body?.success !== false, status: res.status, body };
}

// 4xx from the API is usually a real validation message worth showing; 5xx is not.
function relay(result, fallback) {
  const msg = result.status >= 400 && result.status < 500 && result.body?.error
    ? String(result.body.error)
    : fallback;
  return json({ success: false, error: msg }, result.status >= 500 ? 502 : 400);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function cap(v, max) {
  return String(v).slice(0, max);
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

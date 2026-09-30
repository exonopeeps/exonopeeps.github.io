/**
 * POST /api/participate — walk-up lead capture.
 *
 * One submit becomes up to three upstream calls:
 *   1. POST /api/offerings                 -> creates the lead Offering, returns OFID
 *   2. POST /api/entity-mappings           -> bridges Offering <-> Seller <-> MarketOperator
 *   3. POST /api/offerings/{ofid}/photo    -> optional hero image
 */
import { json, str, cap, apiBase, upstream, relay, containsUrl } from './lib.js';

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
  specialty: 30, tags: 120,
};

const REQUIRED = ['name', 'email', 'offering', 'category', 'description'];

// The Partner API refuses a web address in these on create (UrlDetector). Company is not in
// the list: it is stored in OfferingDetails, the one column allowed to hold a link.
const NO_URL = { name: 'name', offering: 'headline', description: 'description', specialty: 'specialty', tags: 'tags' };

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE = /^image\/(jpeg|png|webp|heic|heif)$/i;

export async function participate(request, env) {
  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  }

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

  const base = apiBase(env);
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
  // No link field: Offering has no website column, and VideoLink is not one — Public renders
  // any non-null VideoLink as a <video> player, so a site URL there shows a broken video.

  const created = await upstream(env, 'POST', '/api/offerings', offering);
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
  const mapped = await upstream(env, 'POST', '/api/entity-mappings', {
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
  for (const [key, label] of Object.entries(NO_URL)) {
    if (containsUrl(f[key])) errors.push(`Please leave web addresses out of your ${label}.`);
  }
  return errors;
}

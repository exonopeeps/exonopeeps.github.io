# Participate proxy

Cloudflare Worker behind `https://www.exonopeeps.com/api/participate`. It exists so the
static site never holds a credential: the site is GitHub Pages, so anything the page knows
is readable from DevTools. SPID, MOID and the partner API key live here instead.

## What one submit does

| Step | Call | Why |
|---|---|---|
| 1 | `POST /api/offerings` | Creates the lead Offering (`Type: 6`). Returns `OFID`. |
| 2 | `POST /api/entity-mappings` | Bridges Offering ↔ Seller ↔ MarketOperator. Offering has no SPID column, so without this the listing belongs to nobody. |
| 3 | `POST /api/offerings/{ofid}/photo` | Optional hero image. Best effort — a failure here never fails the submission. |

Step 2 must precede step 3: the API establishes ownership of an offering by looking for an
EntityMapping belonging to the caller's brand, so an unmapped offering's photo endpoint
answers 404.

## Deploy

```bash
cd worker
npm install -g wrangler        # once
wrangler login                 # once

# Secrets — never put these in wrangler.toml, this repo is public.
wrangler secret put EXONOME_API_KEY   # needs scopes: offerings:write, entity-mappings:write
wrangler secret put EXONOME_SPID
wrangler secret put EXONOME_MOID

wrangler deploy
wrangler secret list           # verify
```

Non-secret settings (`EXONOME_API_BASE`, `EVENT_NAME`, `LISTING_STATUS`) are in
`wrangler.toml`.

## Watch it

```bash
wrangler tail
```

Two log lines matter:

- `ORPHANED OFFERING <ofid>` — the Offering was created but the EntityMapping failed, so it
  exists with no seller or market. Map it by hand; the OFID is in the line.
- `photo upload for OFID <ofid> returned <status>` — the person is on the Exchange, only the
  image is missing.

## Notes

- `LISTING_STATUS` is `4` (Live), so a submission publishes to the market immediately with
  no review step. A honeypot field catches naive bots, but nothing stops a determined person
  at the venue from posting junk. Set it to `0` (pending) to gate on review instead.
- Offering has no website column, so a participant's link is stored in `VideoLink` — the only
  free-text URL field on the entity apart from `DigitalDownloadLink`.
- Field length caps are duplicated from the API's `[MaxLength]` attributes. If those change,
  change `LIMITS` here and `RULES` in `participate/index.html` too.

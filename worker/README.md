# ExonoPeeps API Worker

Cloudflare Worker behind `https://www.exonopeeps.com/api/*`. It exists so the static site
never holds a credential: the site is GitHub Pages, so anything the page knows is readable
from DevTools. The partner API key, SPID, MOID and the session secret live here instead.

| Route | Page | What it does |
|---|---|---|
| `POST /api/participate` | `/participate/` | Walk-up: creates a new lead card. |
| `/api/claim/*` | `/claim/` | A participant signs in by email code and enriches their existing card. |
| `GET /api/wall` | the big screen, and the claim page's counter | Live cards, newest change first. No emails. |

## Participate: what one submit does

| Step | Call | Why |
|---|---|---|
| 1 | `POST /api/offerings` | Creates the lead Offering (`Type: 6`). Returns `OFID`. |
| 2 | `POST /api/entity-mappings` | Bridges Offering ↔ Seller ↔ MarketOperator. Offering has no SPID column, so without this the listing belongs to nobody. |
| 3 | `POST /api/offerings/{ofid}/photo` | Optional hero image. Best effort — a failure here never fails the submission. |

Step 2 must precede step 3: the API establishes ownership of an offering by looking for an
EntityMapping belonging to the caller's brand, so an unmapped offering's photo endpoint
answers 404.

## Claim: how it works

1. `POST /api/claim/start {email}` — looks the email up in `EntityMapping.EmailInvited` for
   `CLAIM_MOID` and emails a 6-digit code. The reply is **the same whether or not the email is
   on the list**; an unknown email gets a "not on the list, add yourself" note instead.
2. `POST /api/claim/verify {email, code}` — sets an HttpOnly session cookie bound to that one
   OFID, and returns the card.
3. `GET /api/claim/me`, `POST /api/claim/save`, `POST /api/claim/photo`. There is no sign-in or sign-out: the code confirms the email, and the confirmation lasts 12 hours.

Rules the Worker enforces:

- The OFID comes from the signed session, never from the request. The partner key can write
  to any offering the brand owns, so this is the guard that matters.
- Codes: 10 minutes, single use, 5 wrong guesses, stored only as a keyed hash. 3 codes per
  email per 15 minutes (the 4th answers identically but sends nothing), 30 per IP per hour.
- Editable: description, tags (from `TAG_VOCAB`) and the photo. Nothing else — no link, no specialty
  (Public only uses Specialty as hidden search text).
- **Claiming is consent.** Save needs the "Be discoverable" decision (`leadsToMe`):
  - accepted → `TargetPersonEmail` becomes the participant's confirmed email and the card is live
    (EntityMapping Status 4);
  - declined → introductions go back to `EVENT_INBOX` (if they had been routed to them) and the card is
    **paused** (Status 6, via `PATCH /api/entity-mappings/{emid}/status`).
  Live (4) and paused (6) cards can be claimed, so someone who declined can come back and accept.
  "N of M claimed" counts only live cards (M) whose owner accepted (N).
- No web addresses or emails in any text field. Only fields that actually changed are
  sent, so a card whose description already names `Trickly.io` can still be saved.
- Every confirmation and change goes to D1 `audit` with the values it replaced.
- `FREEZE_EDITS = "1"` stops all saves and photo uploads at once.
- D1 holds emails only as keyed hashes.

Saving needs the Partner API's `PATCH /api/offerings/{ofid}/details` (v3.2.0). Until that
is deployed, confirming, the card view and photos work; **Save** returns the API's 404.

The no-URL pattern in `src/lib.js` and both pages is a copy of the API's
`Services/UrlDetector.cs`. If one changes, change all four.

## Test locally

The browser never needs a key or token. The page on `127.0.0.1:5500` (VS Code Live Server)
talks to the Worker on `127.0.0.1:8787`; only the Worker holds the partner key. The page
switches to `:8787` by itself when it is opened on `127.0.0.1` or `localhost`.

```bash
cd worker
npm install -g wrangler                     # once; needs Node.js
cp .dev.vars.example .dev.vars              # then fill it in (gitignored)
wrangler d1 migrations apply exonopeeps-claim --local
wrangler dev --ip 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:5500/claim/` — use the same hostname for page and Worker, or the
session cookie is not sent. With `DEV_ECHO_CODE=1` the code is shown on the page and in the
`wrangler dev` log instead of being emailed.

What `.dev.vars` needs:

- `EXONOME_API_KEY` — the **Development** partner key (Maintenance → Partner Keys → Create,
  custom domain `exono`, scopes `offerings:read`, `offerings:write`, `entity-mappings:read`,
  `entity-mappings:write`). It resolves the staging database, so use staging test cards; the
  **Production** key edits real participants' cards and belongs only in `wrangler secret put`.
  Existing keys can't gain scopes, so both keys are new.
- `SESSION_SECRET` — any long random string.
- `CLAIM_MOID` / `CLAIM_OFID_MIN` / `CLAIM_OFID_MAX` if the test cards are not The Exchange
  2026. At least one card needs `EmailInvited` set to an address you can use.

## Deploy

```bash
cd worker
wrangler login                                  # once

wrangler d1 create exonopeeps-claim             # once; paste database_id into wrangler.toml
wrangler d1 migrations apply exonopeeps-claim --remote

# Secrets — never put these in wrangler.toml, this repo is public.
wrangler secret put EXONOME_API_KEY   # offerings:read, offerings:write, entity-mappings:read, entity-mappings:write
wrangler secret put EXONOME_SPID
wrangler secret put EXONOME_MOID
wrangler secret put SESSION_SECRET
wrangler secret put SENDGRID_API_KEY

wrangler deploy
wrangler secret list           # verify
```

Non-secret settings are in `wrangler.toml`. Never set `DEV`, `DEV_ECHO_CODE` or
`DEV_ORIGINS` in production: they echo codes and open CORS.

Email goes out through **SendGrid** (secret `SENDGRID_API_KEY`) from `EMAIL_FROM`, which must be a
sender SendGrid has already verified (a Single Sender, or an authenticated domain). A code that lands
in spam stops the whole flow, so send yourself one before the event. Cloudflare Email Service is also
supported through the `EMAIL` binding, commented out in `wrangler.toml` because it needs the Workers
paid plan; when bound it takes precedence.

Locally, the runner reads the SendGrid key from `D:\private\sendgrid-api-key.txt` — the single source
for that key across all apps and agents: never copy it into `.dev.vars`, config or the repo; a roll
updates only the file.

## Watch it

```bash
wrangler tail
```

Log lines that matter:

- `ORPHANED OFFERING <ofid>` — a walk-up Offering was created but the EntityMapping failed,
  so it exists with no seller or market. Map it by hand; the OFID is in the line.
- `photo upload for OFID <ofid> returned <status>` — the person is on the Exchange, only the
  image is missing.
- `cloudflare email failed: <code> <message>` (or `sendgrid -> <status>`) — a code did not go out.
- `claim: N cards share one email` — two cards carry the same `EmailInvited`; the lower OFID wins.

## Notes

- `LISTING_STATUS` is `4` (Live), so a walk-up submission publishes to the market immediately
  with no review step. A honeypot field catches naive bots, but nothing stops a determined
  person at the venue from posting junk. Set it to `0` (pending) to gate on review instead.
- Participate takes no link. Offering has no website column, and `VideoLink` is not a
  substitute: Public renders any non-null `VideoLink` as a `<video>` player, so a site URL
  there shows up as a broken video.
- Field length caps are duplicated from the API's `[MaxLength]` attributes. If those change,
  change `LIMITS` in `participate.js`/`claim.js` and the page `RULES`/`LIMIT` too.

-- Claim flow state. The platform stays the source of truth for the card itself; this holds
-- only what the platform has no place for. Emails appear only as keyed hashes (email_key).

-- One row per code sent. ofid/code_hash are NULL when the email is not on the list: the row
-- still exists so rate limits apply to unknown emails exactly as to known ones.
CREATE TABLE IF NOT EXISTS codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_key   TEXT    NOT NULL,
  ofid        INTEGER,
  emid        INTEGER,
  code_hash   TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     INTEGER,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS codes_email ON codes (email_key, created_at);
CREATE INDEX IF NOT EXISTS codes_ip    ON codes (ip, created_at);

-- A card is claimed once its owner has verified. updated_at drives the big screen.
CREATE TABLE IF NOT EXISTS claims (
  ofid           INTEGER PRIMARY KEY,
  emid           INTEGER,
  email_key      TEXT    NOT NULL,
  claimed_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  photo_url      TEXT,
  photo_at       INTEGER
);

-- Every sign-in and change, with the values it replaced, so any edit can be undone by hand.
CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ofid         INTEGER NOT NULL,
  email_key    TEXT,
  action       TEXT    NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  at           INTEGER NOT NULL,
  ip           TEXT,
  ua           TEXT
);
CREATE INDEX IF NOT EXISTS audit_ofid ON audit (ofid, at);

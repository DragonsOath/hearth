-- Hearth's licence service: promo codes (hash only), who redeemed them, licences taken back.
CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  features TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  days INTEGER,
  redeem_by TEXT,
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  campaign_id TEXT,
  note TEXT,
  hint TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS redemptions (
  code_id TEXT NOT NULL REFERENCES codes(id),
  install TEXT NOT NULL,
  licence_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ends TEXT,
  PRIMARY KEY (code_id, install)
);
CREATE TABLE IF NOT EXISTS revoked (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tries (
  install TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tries_by_install ON tries(install, at);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  months INTEGER,
  cap INTEGER,
  gift INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS grants (
  licence_id TEXT PRIMARY KEY,
  install TEXT NOT NULL,
  label TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS founder_offer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  campaign_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  min_age_days INTEGER NOT NULL,
  pinned_thread_id TEXT,
  status_message_id TEXT,
  status_line TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  hold_minutes INTEGER,
  claims_announced INTEGER NOT NULL DEFAULT 0,
  intro_posted INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS founder_entries (
  post_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  code_id TEXT,
  decided_at TEXT,
  held_until TEXT,
  reason TEXT,
  told_at TEXT
);
-- Private pictures (11-19): Premium Ember, the secret picture only code holders see. Uploaded by the
-- owner's deploy step (README, Premium Ember); never in the repository or on the website.
CREATE TABLE IF NOT EXISTS private_assets (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data_b64 TEXT NOT NULL
);

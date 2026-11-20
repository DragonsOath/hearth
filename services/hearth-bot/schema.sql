-- The official Hearth bot's relay: which Hearth owns which Discord server.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs(id),
  name TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guilds_by_install ON guilds(install_id);

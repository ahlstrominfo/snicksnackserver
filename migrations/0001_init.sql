-- Inställningar som nyckel/värde: name, color, accepts (JSON), icon (tidpunkt för uppladdad logga).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Mål som avsändarna kan skicka till. id är fast (det ingår i sökvägarna i R2).
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grp TEXT,
  created_at TEXT NOT NULL
);

-- Avsändare. Nyckeln sparas bara som SHA-256 (hex); key_hash NULL = spärrad.
CREATE TABLE senders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE,
  key_hint TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE sender_targets (
  sender_id TEXT NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  PRIMARY KEY (sender_id, target_id)
);

-- Index över mottagna snack. Filerna ligger i R2 under <target_id>/<sender_id>/<snack_id>/.
-- Ingen främmande nyckel: snacken ligger kvar även om målet eller avsändaren tas bort.
CREATE TABLE snacks (
  target_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  snack_id TEXT NOT NULL,
  title TEXT,
  recorded_at TEXT,
  duration REAL,
  language TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (target_id, sender_id, snack_id)
);

CREATE INDEX snacks_updated ON snacks (updated_at DESC);

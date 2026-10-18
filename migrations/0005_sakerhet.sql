-- Säkerhetshärdning: revisionslogg, spärr efter misslyckade inloggningar, kvoter per avsändare och den personliga
-- länken som hash.

-- Revisionsloggen: vem gjorde vad och när. actor är 'ägaren', 'avsändare:<id>', 'agent:<id>' eller 'oauth:<id>'.
-- Rader äldre än 90 dagar tas bort (vid skrivning och av den nattliga städningen).
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit (at);

-- Misslyckade adminlösenord (admin och /authorize), en rad per försök. Städas efter ett dygn.
CREATE TABLE login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX login_failures_ip ON login_failures (ip, at);
CREATE INDEX login_failures_at ON login_failures (at);

-- Spärrar efter för många misslyckade försök: scope är 'ip:<adress>' eller 'alla'.
CREATE TABLE login_locks (
  scope TEXT PRIMARY KEY,
  until TEXT NOT NULL
);

-- Kvoter per avsändare. NULL = standarden under Inställningar (settings: quota_ai_requests_day,
-- quota_ai_tokens_30d, quota_storage_mb); tom standard = obegränsat.
ALTER TABLE senders ADD COLUMN quota_ai_requests_day INTEGER;
ALTER TABLE senders ADD COLUMN quota_ai_tokens_30d INTEGER;
ALTER TABLE senders ADD COLUMN quota_storage_mb INTEGER;

-- Den personliga länken (/min/<token>) sparas bara som SHA-256, som nycklarna. Befintliga page_token hashas av
-- Workern (D1 saknar sha256 i SQL): vid första användningen, när ägaren öppnar Avsändare och av städningen.
-- Därefter är page_token alltid NULL.
ALTER TABLE senders ADD COLUMN page_hash TEXT;
ALTER TABLE senders ADD COLUMN page_created_at TEXT;
CREATE UNIQUE INDEX senders_page_hash ON senders (page_hash);

-- Lagring per avsändare summeras ur snacks.bytes.
CREATE INDEX snacks_sender ON snacks (sender_id);
CREATE INDEX usage_sender_day ON usage (sender_id, day);

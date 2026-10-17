-- MCP för agenter: agentnycklar, en personlig sida per avsändare och fulltextsök.

-- owner: 'owner' (ägaren, ser allt) eller ett sender_id (ser bara den avsändarens snack).
-- Nyckeln sparas bara som SHA-256 (hex); key_hash NULL = spärrad.
CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE,
  key_hint TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX agent_keys_owner ON agent_keys (owner);

-- Länken till avsändarens personliga sida (/min/<token>). Skapas när den behövs.
ALTER TABLE senders ADD COLUMN page_token TEXT;
CREATE UNIQUE INDEX senders_page_token ON senders (page_token);

-- Antal ord i snacket (för list_snacks). Fylls vid mottagning och när sökindexet byggs om.
ALTER TABLE snacks ADD COLUMN word_count INTEGER;

-- Fulltextsök i titel, text, anteckning och sammanfattningar. Fylls vid mottagning; befintliga snack
-- läggs in med "Bygg om sökindexet" under Agenter i admin (texten ligger i R2, inte i D1).
CREATE VIRTUAL TABLE snacks_fts USING fts5(
  target_id UNINDEXED,
  sender_id UNINDEXED,
  snack_id UNINDEXED,
  title,
  text,
  note,
  summaries,
  tokenize = 'unicode61'
);

-- Extern AI via mottagaren: leverantörer, prompter och ett litet index över förbrukningen.

-- type: anthropic (Messages API), openai (OpenAI-kompatibel chat/completions), test (ingen nyckel, fast text).
-- api_key är krypterad (AES-GCM, nyckel ur secret KEY_SECRET); key_hint är den maskerade formen för admin.
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('anthropic', 'openai', 'test')),
  base_url TEXT,
  api_key TEXT,
  key_hint TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);

-- kind: summary (POST summarize/<id>) eller chat (snabbval i chatten). live: får användas under inspelning.
-- model tom = leverantörens standardmodell. user_text: instruktionen (summary) eller snabbvalets fråga (chat).
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'chat')),
  live INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT,
  system TEXT NOT NULL DEFAULT '',
  user_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE sender_prompts (
  sender_id TEXT NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  PRIMARY KEY (sender_id, prompt_id)
);

-- Förbrukning per dag. Inget av innehållet sparas, bara antal anrop och tokens.
CREATE TABLE usage (
  day TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, sender_id, prompt_id, kind, provider_id, model)
);

-- En ny installation får en testleverantör och två prompter, så att kedjan går att prova utan nycklar.
INSERT INTO providers (id, name, type, created_at) VALUES ('test', 'Test (ingen AI)', 'test', datetime('now'));

INSERT INTO prompts (id, name, description, kind, live, provider_id, user_text, created_at) VALUES
  ('sammanfatta-hittills', 'Sammanfatta hittills', 'Vad som sagts hittills, i några punkter.', 'chat', 1, 'test',
   'Sammanfatta det som sagts hittills i några korta punkter. Ta med beslut och öppna frågor om det finns några.',
   datetime('now')),
  ('kort-sammanfattning', 'Kort sammanfattning', 'De viktigaste punkterna, och beslut om det finns några.', 'summary', 0, 'test',
   'Skriv en kort sammanfattning i ett avsnitt "Sammanfattning" med 3–6 punkter. Lägg beslut och åtgärder i egna avsnitt ("Beslut", "Att göra") om det finns några.',
   datetime('now'));

-- Avsändare som redan finns får båda.
INSERT INTO sender_prompts (sender_id, prompt_id) SELECT id, 'sammanfatta-hittills' FROM senders;
INSERT INTO sender_prompts (sender_id, prompt_id) SELECT id, 'kort-sammanfattning' FROM senders;

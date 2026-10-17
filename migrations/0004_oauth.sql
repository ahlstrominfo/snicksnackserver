-- OAuth 2.1 för MCP-klienter som inte kan skicka en agentnyckel (claude.ai:s kopplare):
-- registrerade klienter (RFC 7591), engångskoder och inloggningar (en rad per godkänd klient med access- och refresh-token).

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON-lista
  created_at TEXT NOT NULL
);

-- Koden sparas bara som SHA-256 och tas bort när den används (en gång) eller går ut.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  owner TEXT NOT NULL, -- 'owner' eller ett sender_id, som agent_keys.owner
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- En inloggning: klienten och identiteten. Tokens sparas bara som SHA-256. Refresh-token byts vid varje förnyelse;
-- den förra gäller en kort stund till (prev_refresh_hash) om klienten inte hann spara den nya.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  access_hash TEXT UNIQUE,
  access_expires_at TEXT,
  refresh_hash TEXT UNIQUE,
  prev_refresh_hash TEXT,
  refreshed_at TEXT,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX oauth_grants_owner ON oauth_grants (owner);
CREATE INDEX oauth_grants_prev ON oauth_grants (prev_refresh_hash);

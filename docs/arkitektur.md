# Arkitektur

Mottagaren är en enda Cloudflare Worker utan byggsteg och utan ramverk. Den lagrar filer i R2, allt annat i D1, och
håller inget tillstånd i minnet mellan anrop. HTML för admin och inloggningssidor byggs direkt i Workern.

```
  Snicksnack (iPhone)                 AI-agenter (Claude Code, claude.ai …)        Webbläsare
        │  api-nyckel                       │  agentnyckel eller OAuth                │  cookie / länk
        ▼                                   ▼                                         ▼
  ┌──────────────────────────────────── Worker (src/index.ts) ────────────────────────────────────┐
  │ /.well-known/snicksnack     /mcp                       /admin/…        /min/<token>             │
  │ /snicksnack/targets         /ljud/<signerad>           /authorize      /icon.png                │
  │ /snicksnack/receive/<mål>   /.well-known/oauth-*       /register /token /revoke                 │
  │ /snicksnack/summarize[/<p>] /snicksnack/chat                                                    │
  └──────┬──────────────────────────┬──────────────────────────────┬──────────────────────────────┘
         │                          │                              │
         ▼                          ▼                              ▼
   R2 (FILER): filerna        D1 (DB): allt annat           AI-leverantör (Anthropic, OpenAI-kompatibel)
                                                            bara vid summarize och chat
```

## Filerna i src/

| Fil | |
|---|---|
| `index.ts` | Ingången: väljer hanterare efter sökväg och metod. Fångar oväntade fel som `500`. |
| `protokoll.ts` | Protokollets kärna: upptäckten, målen, mottagningen och loggan (`/icon.png`). Gemensamma `json` och `fel`. |
| `ai/anrop.ts` | Promptlistan, `summarize` och `chat` (SSE). Räknar anrop och tokens i `usage`. |
| `ai/leverantorer.ts` | Anropen till leverantörerna: `anthropic` (officiella SDK:n), `openai` (fetch mot `chat/completions`), `test` (fast text utan AI). Dekrypterar API-nyckeln per anrop. |
| `ai/transkript.ts` | Transkriptet som text till modellen, systemprompten, sammanfattningens JSON-schema och valideringen av svaret. |
| `mcp.ts` | MCP-servern (Streamable HTTP, statelös, en ny `McpServer` per anrop) med verktygen, och den signerade ljudlänken `/ljud/<token>`. |
| `agenter.ts` | Agentnycklar och omfånget (ägaren ser allt, en avsändare bara sina snack). Avsändarens sidtoken. |
| `oauth.ts` | OAuth 2.1 för MCP-klienter: metadata, registrering, inloggningssidan med PKCE, tokens och återkallande. |
| `sok.ts` | Fulltextindexet (FTS5) och ombyggnaden från R2. |
| `admin.ts` | Admin: inloggning, snack, mål, avsändare, inställningar. |
| `admin-ai.ts` | Admin för leverantörer och prompter. |
| `admin-agenter.ts` | Admin för agentnycklar, inloggade OAuth-klienter och sökindexet. |
| `min.ts` | Avsändarens personliga sida `/min/<token>`. |
| `db.ts` | Inställningar, mål och avsändare i D1. |
| `krypto.ts` | Hashning, nycklar, admin-sessionen, AES-GCM för leverantörsnycklar och signerade länkar. |
| `efter-mottagning.ts` | Krok som körs efter varje mottaget snack (i dag bara en loggrad). Platsen för e-post eller webhook. |
| `html.ts`, `utseende.ts` | En liten HTML-mall som escapar allt som inte uttryckligen är rå HTML, och adminwebbens stil och logga (allt inline). |

## D1-tabellerna

Migrationerna ligger i `migrations/` och körs med `npm run db:migrate:remote` (eller `:local`).

| Tabell | Migration | |
|---|---|---|
| `settings` | 0001 | Nyckel/värde: `name`, `color`, `accepts` (JSON), `icon` (när loggan laddades upp), `chat_provider`, `chat_model`, `chat_system`. |
| `targets` | 0001 | Målen. `id` är fast (det ingår i R2-sökvägarna). |
| `senders` | 0001, 0003 | Avsändarna. `key_hash` är SHA-256 av nyckeln (NULL = spärrad), `key_hint` de fyra sista tecknen, `page_token` länken till den personliga sidan. |
| `sender_targets` | 0001 | Vilka mål en avsändare får skicka till. |
| `snacks` | 0001, 0003 | Index över mottagna snack: mål, avsändare, snack-id, titel, tid, längd, språk, taggar, filer, storlek, antal sändningar och ord. |
| `providers` | 0002 | AI-leverantörer. `api_key` är krypterad. Migrationen lägger in testleverantören. |
| `prompts`, `sender_prompts` | 0002 | Prompterna och vilka avsändare som får använda dem. Migrationen lägger in två exempelprompter. |
| `usage` | 0002 | Anrop och tokens per dag, avsändare, prompt och modell. Inget innehåll. |
| `agent_keys` | 0003 | Agentnycklar för MCP: `owner` är `owner` (ägaren) eller ett avsändar-id. Bara SHA-256. |
| `snacks_fts` | 0003 | FTS5-index över titel, text, anteckning och sammanfattningar. |
| `oauth_clients` | 0004 | Dynamiskt registrerade klienter och deras redirect-adresser. |
| `oauth_codes` | 0004 | Engångskoder (SHA-256), PKCE-utmaningen, giltiga i 10 minuter. |
| `oauth_grants` | 0004 | En rad per godkänd klient: access- och refresh-token (SHA-256), utgångstider, återkallande. |

## R2-layouten

```
<mål-id>/<avsändar-id>/<snack-id>/transcript.json
                                  text.md
                                  audio.m4a        (eller audio.wav, aldrig båda)
_config/icon.png                                    loggan
```

Mål-id får inte börja med `_`, så `_config/` krockar aldrig med ett mål. Snack-id rensas till `[A-Za-z0-9._-]`.
Samma snack från två avsändare, eller till två mål, blir två olika mappar.

## Nycklar och hemligheter

| Vad | Hur | Var |
|---|---|---|
| Avsändarnyckel (`ssk_…`) | 32 slumpade byte. Sparas som SHA-256 (hex), visas en gång. | `senders.key_hash` |
| Agentnyckel (`ssk_agent_…`) | Som ovan. | `agent_keys.key_hash` |
| OAuth-kod, access-token (`ssk_oauth_…`), refresh-token (`ssk_refresh_…`) | Slumpade; bara SHA-256 sparas. Access gäller 1 h, refresh 90 dagar och byts vid varje förnyelse (den förra gäller 2 min till). | `oauth_codes`, `oauth_grants` |
| Personlig sida (`/min/<token>`) | 24 slumpade byte, sparas i klartext så att ägaren kan visa länken igen. Kan bytas. | `senders.page_token` |
| Leverantörernas API-nycklar | AES-GCM 256 med slumpad IV. Nyckeln härleds med HKDF-SHA-256 ur `KEY_SECRET`. Format `v1.<iv>.<chiffer>`. Visas bara maskerade. | `providers.api_key` |
| Admin-sessionen | Cookie `<utgång>.<HMAC-SHA-256>`, nyckel härledd ur `ADMIN_PASSWORD`, giltig 30 dagar. `HttpOnly`, `SameSite=Lax`, `Secure` på https. | Bara i webbläsaren |
| Ljudlänk för agenter | `/ljud/<base64url(utgång + R2-nyckel)>.<HMAC>`, nyckel ur `KEY_SECRET`, giltig 1 h. | Bara i länken |
| CSRF på OAuth-inloggningen | HMAC över en cookie och begärans parametrar, nyckel ur `KEY_SECRET` (eller `ADMIN_PASSWORD`). | Formulär och cookie |

Nycklarna hashas utan salt: de är långa slumpade strängar, inte lösenord, så en uppslagning på hashen räcker.

## OAuth-flödet (claude.ai och andra MCP-klienter)

```
klient                         mottagaren                          användaren
  │ POST /mcp (utan token) ──────▶ 401 WWW-Authenticate: resource_metadata=…
  │ GET /.well-known/oauth-protected-resource ─▶ authorization_servers
  │ GET /.well-known/oauth-authorization-server ─▶ endpoints, S256
  │ POST /register ──────────────▶ client_id (publik klient, ingen hemlighet)
  │ öppnar /authorize?…&code_challenge=… ──────────────────────────▶ inloggningssidan
  │                                                     lösenord (ägare) eller /min-länk/agentnyckel (avsändare)
  │ ◀── redirect_uri?code=…&state=…&iss=… ◀─────────────────────────┘
  │ POST /token (code + code_verifier) ─▶ access_token + refresh_token
  │ POST /mcp  Authorization: Bearer ssk_oauth_… ─▶ verktygen, med ägarens eller avsändarens omfång
```

Redirect-adresser måste vara https, http till `localhost`/`127.0.0.1`/`[::1]`, eller ett appschema
(`cursor://…`). En spärrad avsändare förlorar alla sina inloggningar och agentnycklar direkt, eftersom varje anrop
kontrollerar att avsändaren fortfarande har en nyckel.

## Vad som är statelöst

- **Workern** håller inget i minnet mellan anrop; allt ligger i D1 och R2. Den kan köras i hur många instanser som helst.
- **MCP** är statelös Streamable HTTP: ingen session, ingen `Mcp-Session-Id`. Varje POST bär sin egen inloggning.
- **Sammanfattning och chatt** sparar inget innehåll. Transkriptet kommer med i varje anrop och chattens historik
  skickas av appen varje gång. Bara antal anrop och tokens per dag sparas (`usage`).
- **Det som sparas** är snacken (R2), indexet över dem och sökindexet (D1), samt konfigurationen: mål, avsändare,
  prompter, leverantörer, nycklar och OAuth-inloggningar.

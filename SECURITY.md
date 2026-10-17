# Säkerhet

## Rapportera en sårbarhet

Hittar du en sårbarhet: mejla Mattias Ahlström (adressen: se profilen, [github.com/ahlstrominfo](https://github.com/ahlstrominfo)).
Skriv vad det gäller, hur det går att återskapa och vilken version (commit) du provade. Öppna inte ett publikt issue
för något som går att utnyttja innan det är rättat; mindre saker (härdning, dokumentation) går bra som issue.
Svenska eller engelska. Du får svar så snart jag kan, och tack i commit-meddelandet om du vill.

Det här är ett litet projekt som drivs av en person, utan bug bounty.

## Vad som skyddas och hur

Se också [docs/arkitektur.md](docs/arkitektur.md#nycklar-och-hemligheter).

| | |
|---|---|
| **Avsändar- och agentnycklar, OAuth-tokens och koder** | Långa slumpade strängar (32 byte). Bara SHA-256 sparas i D1; nyckeln visas en gång. En databaskopia räcker inte för att logga in. |
| **AI-leverantörernas API-nycklar** | Krypterade med AES-GCM 256 (slumpad IV per nyckel), nyckeln härledd med HKDF ur secret `KEY_SECRET`. Visas bara maskerade i admin. Utan `KEY_SECRET` går nycklar inte att spara. |
| **Admin** | Lösenordet i secret `ADMIN_PASSWORD`, jämfört i konstant tid. Sessionen är en cookie med utgångstid och HMAC-SHA-256 (nyckel ur lösenordet), `HttpOnly`, `SameSite=Lax`, `Secure` på https, giltig 30 dagar. Byts lösenordet loggas alla ut. |
| **CSRF** | Admin och den personliga sidan nekar POST med en annan `Origin`, utöver `SameSite=Lax` på cookien. OAuth-inloggningen har dessutom en token i formuläret, HMAC-bunden till en egen cookie och till begärans parametrar. |
| **Ljud till agenter** | `get_audio_url` ger en länk signerad med HMAC (nyckel ur `KEY_SECRET`) som gäller en timme och bara pekar på en fil. |
| **Omfång** | En avsändares nyckel ser bara de mål och prompter ägaren gett den. En avsändares agentnycklar och OAuth-inloggningar ser bara avsändarens egna snack. Spärras avsändaren slutar allt detta fungera direkt. |
| **OAuth** | Bara publika klienter med PKCE `S256`. Redirect-adressen måste vara exakt den registrerade (https, http till den egna datorn, eller ett appschema). Koder gäller 10 minuter och en gång. Refresh-token byts vid varje förnyelse. Inloggningssidan får inte ramas in (`frame-ancestors 'none'`). |
| **HTML** | Allt som visas escapas av mallen i `src/html.ts` om det inte uttryckligen är rå HTML. |
| **Innehållet i AI-anropen** | Sparas inte. Bara antal anrop och tokens per dag. Det går däremot till den AI-leverantör du valt. |

**Det som inte skyddas särskilt:**

- **Inga egna rate limits.** Inloggningen i admin och OAuth-inloggningen begränsar inte antalet försök. Använd ett långt
  slumpat `ADMIN_PASSWORD` (till exempel `openssl rand -base64 24`), och lägg gärna en regel för rate limiting i
  Cloudflare (Security → WAF → Rate limiting rules) på `/admin/login` och `/authorize`.
- **Länken till den personliga sidan** (`/min/<token>`) är en inloggning. Den sparas i klartext i D1 så att ägaren kan
  visa den igen, och kan bytas under Avsändare.
- **Filerna i R2 är okrypterade** utöver Cloudflares egen kryptering i vila. Den som har tillgång till ditt
  Cloudflare-konto kan läsa snacken.
- **Adminsidorna** saknar `X-Frame-Options`; skyddet mot inramning bygger på `SameSite=Lax`.

## Hemligheterna

Workern har två secrets. Sätt dem med `npx wrangler secret put`, aldrig i `wrangler.jsonc` eller i git. Lokalt ligger
de i `.dev.vars` (gitignorerad).

| | Används till | Om den saknas |
|---|---|---|
| `ADMIN_PASSWORD` | Admin, ägarens OAuth-inloggning, nyckeln till admin-sessionen. | Admin och `/authorize` svarar `503`. |
| `KEY_SECRET` | Krypteringen av leverantörernas API-nycklar, ljudlänkarna, CSRF-token på OAuth-inloggningen. | API-nycklar går inte att spara, `get_audio_url` fungerar inte, CSRF använder `ADMIN_PASSWORD`. |

### Byta `KEY_SECRET`

```sh
openssl rand -base64 48 | npx wrangler secret put KEY_SECRET
```

Det här händer:

- **Leverantörernas API-nycklar går inte att läsa.** Sammanfattning och chatt svarar `500` ("API-nyckeln … går inte
  att läsa (har KEY_SECRET bytts?)") tills du lagt in nycklarna igen under **Leverantörer**. Testleverantören påverkas inte.
- **Ljudlänkar** som redan delats ut slutar fungera (de gäller ändå bara en timme).
- **OAuth-inloggningar som pågår** just då måste börja om.
- **Inte påverkat:** avsändarnycklar, agentnycklar, OAuth-tokens (de är hashade, inte krypterade), admin-sessionen och
  snacken.

Byt `KEY_SECRET` om du tror att den läckt. Byt samtidigt API-nycklarna hos leverantörerna, eftersom den som har både
`KEY_SECRET` och en kopia av databasen kan dekryptera dem.

### Byta `ADMIN_PASSWORD`

`npx wrangler secret put ADMIN_PASSWORD`. Alla admin-sessioner blir ogiltiga och du loggar in med det nya. OAuth-
inloggningar som redan är gjorda fortsätter att gälla; återkalla dem under **Agenter** om det behövs.

### Om en nyckel läckt

- **Avsändarnyckel:** **Ny nyckel** under Avsändare (den gamla slutar gälla), eller **Spärra**.
- **Agentnyckel:** **Spärra** under Agenter eller på avsändarens sida.
- **OAuth-inloggning:** **Återkalla** under Inloggade klienter.
- **Länken till personliga sidan:** **Byt länk** under Avsändare.

# Säkerhet

## Rapportera en sårbarhet

Hittar du en sårbarhet: mejla Mattias Ahlström (adressen: se profilen, [github.com/ahlstrominfo](https://github.com/ahlstrominfo)).
Skriv vad det gäller, hur det går att återskapa och vilken version (commit) du provade. Öppna inte ett publikt issue
för något som går att utnyttja innan det är rättat; mindre saker (härdning, dokumentation) går bra som issue.
Svenska eller engelska. Du får svar så snart jag kan, och tack i commit-meddelandet om du vill.

Det här är ett litet projekt som drivs av en person, utan bug bounty.

## Rekommendationer när du sätter upp

Den som sätter upp en mottagare driver den själv och ansvarar för den. Workern gör det som går att göra i koden (se
nästa avsnitt): rate limits, spärr efter fel lösenord, kvoter, revisionslogg och säkerhetshuvuden. En del skydd hör
ändå hemma i Cloudflare eller hos AI-leverantören, som ett andra lager. Det här är vad vi rekommenderar, i den ordning
det ger mest.

**Gör alltid, tar ungefär en timme:**

1. **Långt slumpat lösenord.** `openssl rand -base64 24 | npx wrangler secret put ADMIN_PASSWORD`. Lösenordet är
   hela skyddet för admin och ägarens OAuth-inloggning. Workern begränsar försöken (se nedan), men ett kort lösenord
   går ändå att gissa med tid och många adresser.
2. **En WAF-regel som andra lager.** Workern har egna rate limits (5 inloggningar per minut och IP, 10 registreringar,
   30 token-anrop) och spärrar lösenordsinloggningen en timme efter 20 fel från en adress eller 100 från alla. Workerns
   gränser räknas per Cloudflare-plats och är ungefärliga (i ett prov gick över hundra anrop igenom innan den slog
   till), så i praktiken är det spärren i databasen som skyddar lösenordet. Anropen når ändå Workern. En regel under Cloudflare →
   Security → WAF → Rate limiting rules på `/admin/login`, `/authorize` och `/register` (till exempel 5 per minut och
   IP) stoppar dem före Workern och ingår i gratisplanen.
3. **Cloudflare Access framför admin.** Zero Trust → Access → Applications: en självhostad applikation för
   `<din domän>/admin*`, inloggning med engångskod till din e-post eller Google. Gratis upp till 50 användare. Då måste
   man förbi Access innan lösenordet ens går att prova, och Access loggar varje inloggning.
4. **HSTS på zonen.** SSL/TLS → Edge Certificates → HTTP Strict Transport Security. Och sätt SSL-läget till Full (strict).
5. **Kvoter i admin, och ett utgiftstak hos leverantören.** Sätt standardkvoter (AI-anrop per dygn, tokens per 30
   dagar, lagring) och en global AI-budget under Inställningar, och undantag per avsändare under Avsändare. Workern
   stoppar då anropen med `429` när ett tak nås. Kvoterna kontrolleras före anropet och parallella anrop kan gå något
   över, så skapa också en egen nyckel bara för mottagaren med utgiftstak hos leverantören (Anthropic: en egen
   workspace med spend limit; OpenAI: en projektnyckel med budget). Det är det enda tak som håller om något i Workern
   blir fel.

**Gör innan andra än du själv skickar:**

6. **Spärra i stället för att hoppas.** Ge varje person en egen avsändare, så kan du spärra en nyckel utan att de andra
   påverkas. Byt den personliga länken (`/min/<token>`) om den delats på ett sätt du inte litar på.
   Se efter under **Logg** i admin om något ser konstigt ut.
7. **Begränsa vad som skickas.** Sätt `accepts` till bara text under Inställningar om du inte behöver ljudet. Text är
   några hundra kilobyte, ljud är 60–70 MB per timme och är det som är känsligast.
8. **Håll kontot säkert.** Cloudflare-kontot ser alla filer i R2 och hela databasen. Tvåfaktor på kontot, och inga
   fler API-tokens än du behöver.
9. **Titta i admin då och då.** Under Agenter syns agentnycklar och OAuth-inloggningar med senaste användning;
   återkalla det du inte känner igen. Under Leverantörer syns förbrukningen.

**Om det ska bli mer än ett privat verktyg:** passkeys eller flera admin-konton i Workern, och Dependabot på repot.
Pull requests för sådant är välkomna.

## Vad som skyddas och hur

Se också [docs/arkitektur.md](docs/arkitektur.md#nycklar-och-hemligheter).

| | |
|---|---|
| **Avsändar- och agentnycklar, OAuth-tokens och koder, personliga länken** | Långa slumpade strängar (24–32 byte). Bara SHA-256 sparas i D1; nyckeln och länken visas en gång. En databaskopia räcker inte för att logga in. |
| **AI-leverantörernas API-nycklar** | Krypterade med AES-GCM 256 (slumpad IV per nyckel), nyckeln härledd med HKDF ur secret `KEY_SECRET`. Visas bara maskerade i admin. Utan `KEY_SECRET` går nycklar inte att spara. |
| **Admin** | Lösenordet i secret `ADMIN_PASSWORD`, jämfört i konstant tid. Sessionen är en cookie med utgångstid och HMAC-SHA-256 (nyckel ur lösenordet), `HttpOnly`, `SameSite=Lax`, `Secure` på https, giltig 30 dagar. Byts lösenordet loggas alla ut. |
| **Gissning av lösenordet** | Rate limit per IP på `/admin/login` och lösenordsvägen i `/authorize` (5 per minut, Cloudflares bindning, `429` med `Retry-After`). Spärr i D1 efter 20 fel från en IP eller 100 från alla den senaste timmen: lösenordsinloggningen svarar `429` i en timme, också med rätt lösenord (`LOGIN_LOCK_IP`, `LOGIN_LOCK_GLOBAL`). En session som redan finns påverkas inte. Spärren loggas. |
| **Gissning av nycklar och länkar, överbelastning** | Ogiltiga nycklar, MCP-tokens och `/min`-länkar räknas per IP (20 per minut, sedan `429`). Mottagning 30 per minut och avsändare (`503` med `Retry-After`, så att appen försöker igen), summarize och chat 10 per minut och avsändare, MCP 60 per minut och nyckel, `/register` 10 och `/token` 30 per minut och IP. Bindningen räknas per Cloudflare-plats och är ungefärlig. |
| **Kostnad och lagring** | Kvoter per avsändare (AI-anrop per dygn, tokens per 30 dagar, lagring i MB) och en global AI-budget i tokens per 30 dagar, inställda i admin. Ett tak som nåtts ger `429` med en svensk förklaring som appen visar. |
| **Revisionslogg** | Inloggningar (lyckade, misslyckade, spärrar) med IP och kort user agent, nycklar skapade, bytta och spärrade, OAuth-inloggningar skapade och återkallade, ändrade inställningar, leverantörer och prompter, ljudlänkar och borttagna snack. Under **Logg** i admin; rader äldre än 90 dagar tas bort. Inga nycklar eller innehåll. |
| **Uppladdat innehåll** | Ljudet ska börja som wav (`RIFF…WAVE`) eller m4a (`ftyp` i byte 4–8), annars `415`. Transkriptet ska vara ett JSON-objekt med `words` som lista och rimliga typer, annars `400`. Filerna visas med `X-Content-Type-Options: nosniff` och `Content-Security-Policy: sandbox`. |
| **CSRF** | Admin och den personliga sidan nekar POST med en annan `Origin`, utöver `SameSite=Lax` på cookien. OAuth-inloggningen har dessutom en token i formuläret, HMAC-bunden till en egen cookie och till begärans parametrar. |
| **Ljud till agenter** | `get_audio_url` ger en länk signerad med HMAC (nyckel ur `KEY_SECRET`) som gäller en timme och bara pekar på en fil. |
| **Omfång** | En avsändares nyckel ser bara de mål och prompter ägaren gett den. En avsändares agentnycklar och OAuth-inloggningar ser bara avsändarens egna snack. Spärras avsändaren slutar allt detta fungera direkt. |
| **OAuth** | Bara publika klienter med PKCE `S256`. Redirect-adressen måste vara exakt den registrerade (https, http till den egna datorn, eller ett appschema). Koder gäller 10 minuter och en gång. Refresh-token byts vid varje förnyelse. Klienter som aldrig använts, utgångna koder och gamla inloggningar städas bort varje natt. |
| **HTML** | Allt som visas escapas av mallen i `src/html.ts` om det inte uttryckligen är rå HTML. Alla HTML-svar har `Content-Security-Policy` (`default-src 'none'`, skript bara med en nonce per svar, inga inline-händelser, `frame-ancestors 'none'`, `form-action 'self'` utom på OAuth-inloggningen, vars formulär skickas vidare till klienten), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (`no-referrer` på `/min`) och en minimal `Permissions-Policy`. Stil är tillåten inline (`style-src 'unsafe-inline'`), eftersom mallarna använder style-attribut. |
| **HSTS** | Sätts i Cloudflare-zonen (SSL/TLS → Edge Certificates), inte av Workern: zonen gäller alla svar på domänen, också felsidor från Cloudflare och omdirigeringen från http, och `includeSubDomains`/preload är ett beslut för hela domänen. På workers.dev sätter Cloudflare redan HSTS. |
| **Innehållet i AI-anropen** | Sparas inte. Bara antal anrop och tokens per dag. Det går däremot till den AI-leverantör du valt. |

**Det som inte skyddas särskilt:**

- **Rate limits är ungefärliga.** Cloudflares bindning räknar per plats och i efterhand; en angripare med många
  adresser över många platser kommer längre. Spärren i D1 tar de flesta sådana försök, men ett långt slumpat
  `ADMIN_PASSWORD` är fortfarande grunden, och en WAF-regel stoppar trafiken tidigare.
- **Kvoterna kan överskridas något.** De kontrolleras före anropet och förbrukningen räknas efter, så samtidiga anrop
  kan gå över taket med några anrop. Utgiftstaket hos leverantören är det hårda taket.
- **Den globala spärren kan låsa ute ägaren.** 100 fel från vilka adresser som helst spärrar lösenordsinloggningen en
  timme. En inloggad admin-session fungerar, och spärren går att häva genom att tömma `login_locks` i D1.
- **Filerna i R2 är okrypterade** utöver Cloudflares egen kryptering i vila. Den som har tillgång till ditt
  Cloudflare-konto kan läsa snacken.
- **Personliga länkar från före hashningen** (migration 0005) fungerar men kan inte visas igen i admin. Behöver
  avsändaren länken: **Byt länk** under Avsändare.

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

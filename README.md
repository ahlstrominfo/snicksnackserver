# Snicksnack-mottagare

En öppen referensmottagare för Snicksnack, iOS-appen som gör tal till text på telefonen. Mottagaren är en Cloudflare
Worker som tar emot snack (transkript, text och ljud) som skickas från appen och sparar dem på ditt eget
Cloudflare-konto. Den går att köra på gratisplanen.

Tänkt användning: du sätter upp en mottagare och ger nycklar till de personer som ska skicka till dig, till exempel
dina coacher eller kollegor. Var och en får en egen nyckel och ser bara de mål du har gett dem. Det är en installation
per ägare; vill någon annan ha en egen mottagare sätter de upp sin egen.

**Var vill du börja?**

- **Köra din egen server:** [Sätta upp på ditt eget Cloudflare-konto](#sätta-upp-på-ditt-eget-cloudflare-konto).
- **Koppla AI och agenter:** [Extern AI](#extern-ai) och [Koppla en agent (MCP)](#koppla-en-agent-mcp).
- **Bygga en egen mottagare i annan teknik:** [docs/protokoll.md](docs/protokoll.md) är hela protokollet, med
  curl-exempel. Se också [Bygga en egen mottagare](#bygga-en-egen-mottagare).

Mer: [docs/arkitektur.md](docs/arkitektur.md) (hur Workern är byggd) och [SECURITY.md](SECURITY.md) (vad som skyddas
hur, hemligheterna och hur du rapporterar en sårbarhet).

## Vad den gör

- **Tar emot snack** enligt [protokollet](docs/protokoll.md) (version 1). Filerna hamnar i en R2-hink:
  `<mål>/<avsändare>/<snack-id>/transcript.json`, `text.md` och `audio.m4a` (eller `audio.wav`).
- **Avsändare, mål och ett index över snacken** ligger i en D1-databas. Nycklarna sparas bara som SHA-256.
- **Admin** finns på `/admin`: inställningar (namn, färg, logga, vad appen ska skicka), mål, avsändare med nyckel och
  QR-kod, de mottagna snacken med text och nedladdning, prompter och leverantörer för extern AI, och agentnycklar.
- **Extern AI:** avsändarna kan låta mottagaren sammanfatta ett snack eller chatta om det med en AI-modell du väljer
  (Claude, OpenAI-kompatibla eller en testleverantör utan AI). Se [Extern AI](#extern-ai).
- **MCP för agenter:** Claude Code, Cursor, claude.ai och andra kan söka och läsa snacken, med en agentnyckel eller
  OAuth. Se [Koppla en agent](#koppla-en-agent-mcp).

## Adresserna

| | |
|---|---|
| `GET /.well-known/snicksnack` | Upptäckt: namn, version, adresserna, `accepts`, `color`, `icon`, `summarize`, `chat`, `mcp`, `mcp_auth`. Utan nyckel. |
| `GET /snicksnack/targets` | Målen som avsändaren har tilldelats. `Authorization: Bearer <nyckel>`. |
| `POST /snicksnack/receive/<mål>` | Tar emot ett snack (multipart: `transcript`, `text`, `audio`). Svar `{id, url}`. |
| `GET /snicksnack/summarize` | Prompterna avsändaren får använda. |
| `POST /snicksnack/summarize/<prompt>` | Sammanfattar ett transcript.json med prompten. Svar `{summary, markdown}`. |
| `POST /snicksnack/chat` | Chatt om ett snack, strömmad som `text/event-stream`. |
| `GET /icon.png` | Loggan, om du har laddat upp en. |
| `POST /mcp` | MCP-servern för agenter, med en agentnyckel eller OAuth. |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | OAuth-metadata för MCP-klienter (RFC 9728, RFC 8414). |
| `POST /register`, `/authorize`, `POST /token`, `POST /revoke` | OAuth 2.1: registrering av klienter, inloggningen (PKCE S256), tokens och återkallande. |
| `GET /ljud/<token>` | Ljudet via en signerad länk från MCP-verktyget `get_audio_url` (gäller en timme). |
| `/min/<token>` | En avsändares personliga sida: agentnycklar och hur man kopplar en agent. |
| `/admin` | Admin, inloggning med lösenordet i `ADMIN_PASSWORD`. |

Statuskoder från protokollet: `401` fel eller spärrad nyckel, `404` okänt mål eller ett mål avsändaren inte har,
`413` för stort, `400` trasig kropp, `5xx` vid fel (appen försöker då igen senare). Felen är JSON, `{"error": "…"}`.

Skickas samma snack igen (samma `Idempotency-Key`) skrivs filerna och indexet över. En del som inte kommer med den
gången (till exempel ljudet) ligger kvar från förra sändningen.

## Sätta upp på ditt eget Cloudflare-konto

Det här tar ungefär en kvart. Du behöver:

- **Node.js 22 eller senare** (Wrangler kräver det) och git.
- **Ett Cloudflare-konto** (gratis), [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
- **R2 aktiverat** i kontot: öppna R2 i Cloudflares instrumentpanel en gång och följ anvisningarna. Cloudflare kan be
  om ett betalkort även för gratisnivån.

Alla kommandon körs i repots katalog.

1. **Hämta koden och installera:**

   ```sh
   git clone https://github.com/ahlstrominfo/snicksnackserver.git
   cd snicksnackserver
   npm install
   ```

2. **Gör en egen konfiguration.** `wrangler.example.jsonc` är mallen; din egen `wrangler.jsonc` checkas inte in.

   ```sh
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   Det du kan behöva ändra är markerat med `BYT` i filen: `account_id` (valfritt), `routes` (valfritt, egen domän) och
   `database_id` (krävs, i steg 5).

3. **Logga in i Cloudflare:**

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   `whoami` visar kontot och dess id. Har du flera konton: ta bort kommentaren framför `account_id` i `wrangler.jsonc`
   och fyll i id:t för det konto mottagaren ska ligga på.

4. **Skapa hinken för filerna:**

   ```sh
   npx wrangler r2 bucket create snicksnack-mottagare
   ```

5. **Skapa databasen:**

   ```sh
   npx wrangler d1 create snicksnack-mottagare
   ```

   Wrangler skriver ut ett `database_id` och kan erbjuda sig att lägga in det själv. Gör den inte det: klistra in
   id:t i `wrangler.jsonc` i stället för nollorna (`"database_id": "00000000-…"`).

6. **Skapa tabellerna** (kör migrationerna i `migrations/` mot databasen hos Cloudflare):

   ```sh
   npm run db:migrate:remote
   ```

7. **Kör testerna (valfritt) och deploya:**

   ```sh
   npm test
   npm run deploy
   ```

   Wrangler skriver ut adressen, till exempel `https://snicksnack-mottagare.<ditt-namn>.workers.dev`.

8. **Sätt de två hemligheterna:**

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   openssl rand -base64 48 | npx wrangler secret put KEY_SECRET
   ```

   `ADMIN_PASSWORD` är lösenordet till admin; välj ett långt (det finns ingen spärr mot gissningar, se
   [SECURITY.md](SECURITY.md)). `KEY_SECRET` krypterar AI-leverantörernas API-nycklar och signerar ljudlänkar. Spara
   den inte någon annanstans än i Cloudflare; byts den måste API-nycklarna läggas in igen.

9. **Logga in:** öppna `https://<adressen>/admin` och logga in med lösenordet. Ställ in namn, färg och logga under
   **Inställningar**. Namnet och loggan är det avsändarna ser i appen.

10. **Lägg till den första avsändaren**, se [nedan](#lägga-till-en-avsändare), och skanna QR-koden i appen.

Kontrollera att allt svarar: `https://<adressen>/.well-known/snicksnack` ska visa namnet och adresserna.

Servern är din och ansvaret för den är ditt. Innan du ger nycklar till andra: läs
[rekommendationerna i SECURITY.md](SECURITY.md#rekommendationer-när-du-sätter-upp). De tar en timme i Cloudflare
och stänger de luckor som Workern själv inte täcker.

### Egen domän (valfritt)

Har du en domän i Cloudflare kan Workern ligga på en egen adress, till exempel `snack.example.se`. Ta bort
kommentaren framför `routes` i `wrangler.jsonc`, skriv in domänen och deploya igen:

```jsonc
"routes": [{ "pattern": "snack.example.se", "custom_domain": true }]
```

Det går också att göra under Workers & Pages → snicksnack-mottagare → Settings → Domains & Routes. Mottagaren tar
sina adresser från anropet, så upptäckten pekar rätt oavsett vilken adress som används. Avsändare som redan lagt till
den gamla adressen behöver lägga till den nya.

### Uppdatera till en ny version

```sh
git pull
npm install
npm run db:migrate:remote   # nya migrationer, om det finns några
npm run deploy
```

Din `wrangler.jsonc` och dina secrets påverkas inte. Titta i `wrangler.example.jsonc` om något nytt har tillkommit.

## Lägga till en avsändare

1. Skapa minst ett mål under **Mål** (till exempel "Inkorg"). Id:t går inte att ändra efteråt; det ingår i
   sökvägarna i R2.
2. Under **Avsändare → Ny avsändare**: skriv personens namn, kryssa i de mål och prompter hen ska kunna använda och tryck
   **Skapa och visa nyckel**.
3. Sidan visar nyckeln och en QR-kod med `snicksnack://receiver?url=https://<din-adress>&key=<nyckel>`. Nyckeln visas
   bara den här gången.
4. I Snicksnack: **Inställningar → Mottagare → Lägg till mottagare → Skanna QR-kod**. Det går också att klistra in
   länken eller skriva adressen och nyckeln för hand. Sedan finns mottagaren som val när man skickar ett snack.
5. Tappas nyckeln bort: tryck **Ny nyckel** (den gamla slutar fungera). **Spärra** tar bort nyckeln direkt;
   snacken som redan kommit in ligger kvar.

De mottagna snacken finns under **Snack**, filtrerbara per mål och avsändare. Länken som appen visar efter en
sändning går till snackets sida i admin.

En avsändare går också att skapa från terminalen: `npm run seed -- "Anna" --remote --url https://<din-adress>`
skapar målet "inbox" om det saknas, en avsändare med alla mål och prompter, och skriver ut nyckeln och länken.

## Köra lokalt

`wrangler dev` kör allt lokalt med lokal R2 och D1 (i `.wrangler/`), utan anrop till Cloudflare. Nollorna i
`database_id` räcker lokalt.

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc   # om du inte redan har en
cp .dev.vars.example .dev.vars             # sätt ADMIN_PASSWORD och KEY_SECRET
npm run seed                               # skapar tabellerna, målet "inbox" och en avsändare med alla prompter; skriver ut nyckeln
npm run dev                                # http://localhost:8787
```

Prova med curl (byt `$NYCKEL` mot nyckeln från `npm run seed`). Fler exempel, med ett komplett transcript.json, står i
[protokollet](docs/protokoll.md#prova-en-server-med-curl).

```sh
curl http://localhost:8787/.well-known/snicksnack
curl -H "Authorization: Bearer $NYCKEL" http://localhost:8787/snicksnack/targets
curl -H "Authorization: Bearer $NYCKEL" -H "Idempotency-Key: prov-1" \
  -F "transcript=@transcript.json;type=application/json" \
  -F "text=@prov.md;type=text/markdown" \
  -F "audio=@prov.m4a;type=audio/mp4" \
  http://localhost:8787/snicksnack/receive/inbox
```

iOS-simulatorn når `http://localhost:8787` direkt. `npm run dev` kör `wrangler dev --local-upstream=localhost:8787`:
utan det skulle upptäckten peka på domänen i `routes`. En telefon på samma nät når datorn med
`npx wrangler dev --ip 0.0.0.0 --local-upstream=<datorns-ip>:8787` och `http://<datorns-ip>:8787`; appen tillåter http
bara till lokala nät.

Prova AI-anropen med testleverantören (ingen nyckel behövs):

```sh
curl -H "Authorization: Bearer $NYCKEL" http://localhost:8787/snicksnack/summarize
curl -H "Authorization: Bearer $NYCKEL" -H "Content-Type: application/json" --data-binary @transcript.json \
  http://localhost:8787/snicksnack/summarize/kort-sammanfattning
curl -N -H "Authorization: Bearer $NYCKEL" -H "Content-Type: application/json" \
  -d '{"prompt":null,"messages":[{"role":"user","content":"Vad handlade det om?"}],"transcript":{"text":"Hej. Vi börjar."},"live":true}' \
  http://localhost:8787/snicksnack/chat
```

Tester: `npm test` (vitest i Workers-miljön, med lokal R2 och D1; läser `wrangler.example.jsonc`). Typer:
`npm run typecheck`. Efter ändringar i bindningar eller `vars`: `npm run types` skriver om `worker-configuration.d.ts`.

| Skript | |
|---|---|
| `npm run dev` | Lokal server på port 8787. |
| `npm run deploy` | Deployar till Cloudflare med `wrangler.jsonc`. |
| `npm test`, `npm run typecheck` | Testerna och typkontrollen. |
| `npm run db:migrate:local`, `npm run db:migrate:remote` | Migrationerna lokalt eller hos Cloudflare. |
| `npm run seed` | Mål och avsändare för prov (`-- --remote` för Cloudflare). |
| `npm run types` | Genererar typerna för bindningarna. |

## Begränsningar

- **100 MB per sändning.** Workers tar emot högst 100 MB i en kropp på gratis- och Pro-planen; större anrop stoppas
  av Cloudflare innan de når Workern, och appen får `413`. Ljud i Apple Lossless (16 kHz mono) tar ungefär 66 MB per
  timme, så ett snack på mer än en och en halv timme går inte att skicka med ljud. Stäng av ljudet under
  **Inställningar** om du bara behöver texten.
- **Minnet.** En Worker har 128 MB minne och mottagaren läser hela kroppen innan den sparas. Sändningar nära
  100 MB kan därför misslyckas; appen försöker då igen senare.
- **R2 gratis:** 10 GB lagring per månad (och ett generöst antal anrop). Ett timslångt snack med ljud är ungefär
  66 MB, så det räcker till runt 150 timmar ljud. Utan ljud är snacken några hundra kB.
- **D1 och Workers gratis:** 5 GB databas och 100 000 anrop per dygn, mer än nog här.
- Listan över snack i admin visar de 500 senaste per urval.

## Extern AI

Avsändarna kan låta mottagaren sammanfatta ett snack eller chatta om det, även under en pågående inspelning.
Transkriptet skickas med i varje anrop och ingenting av det sparas på servern; bara antal anrop och tokens per dag
räknas (syns under **Leverantörer**). Protokollet står i [docs/protokoll.md](docs/protokoll.md), avsnitt 4–6.

**Leverantörer** är var anropen går. Lägg in dem under **Leverantörer** (kräver `KEY_SECRET`):

- `anthropic`: Claude via Messages API. Standardmodell `claude-sonnet-5-5`; modellnamnet är fritt. Nyckel från
  [console.anthropic.com](https://console.anthropic.com).
- `openai`: allt som talar OpenAI:s `chat/completions` med strömning. Ange bas-URL, nyckel och modell, till exempel
  `https://api.openai.com/v1`, `https://api.mistral.ai/v1`, Azure (`https://<resurs>.openai.azure.com/openai/v1`)
  eller Ollama (`http://<dator>:11434/v1`, utan nyckel).
- `test`: ingen AI och ingen nyckel. Svarar med en fast text byggd på transkriptet (antal ord och talare, de första
  meningarna) och strömmar den i små bitar. För prov: `[fel]` i frågan ger ett fel mitt i strömmen, `[fel-före]` ett
  fel innan, och `[trasig]` i snackets anteckning en sammanfattning i fel form (502).

API-nycklarna sparas krypterade (AES-GCM med en nyckel härledd ur `KEY_SECRET`) och visas bara maskerade.

**Prompter** har ett id, namn och beskrivning (visas i appen), en sort (`summary` för sammanfattningar, `chat` för
chattens snabbval), om de får användas live, leverantör och modell, en systemtext (tom = mottagarens, under
Inställningar) och en användartext: för en sammanfattning instruktionen som ger avsnitten, för chatt snabbvalets
fråga. Kryssa i vilka avsändare som får använda prompten (det går också under **Avsändare**).

En ny installation har testleverantören och två prompter, **Sammanfatta hittills** (chatt, live) och **Kort
sammanfattning** (sammanfattning), så att allt går att prova utan nycklar. Byt leverantör på dem när du har lagt in
en riktig. Fria frågor i chatten (utan prompt) använder systemtexten under **Inställningar** och leverantören där, om
en är vald.

Några regler i den här mottagaren: en sammanfattningsprompt går bara att använda med summarize och en chattprompt bara
med chat (annars `400`); en prompt som inte är live ger `400` vid `live: true`; en fri fråga (`prompt: null`) kräver
att avsändaren har minst en chattprompt och använder leverantören under Inställningar, eller annars den första
chattpromptens. Upptäckten visar `summarize` bara när det finns minst en sammanfattningsprompt, och appen hämtar
promptlistan därifrån: ha alltså minst en sammanfattningsprompt om chattens snabbval ska synas.

### Startprompter

Bra att skapa under **Prompter** (användartexten står efter namnet):

- **Sammanfatta** (summary): "Sammanfatta snacket i ett avsnitt "Sammanfattning" med 4–8 punkter. Ta med vem som sa
  vad när det spelar roll."
- **Beslut och åtgärder** (summary): "Lista besluten i ett avsnitt "Beslut" och åtgärderna i ett avsnitt "Att göra",
  med vem som ansvarar och när om det sägs. Hitta inte på något som inte sägs; finns inga, skriv en punkt om det."
- **Citat** (summary): "Välj 3–6 ordagranna citat som fångar det viktigaste i snacket, i ett avsnitt "Citat". Ange
  talare och tid för varje."
- **Förtydliga det senaste** (chat, live): "Förklara kort vad som sades de senaste minuterna och vad det betyder. Lyft
  fram oklarheter eller frågor som borde ställas."
- **Sammanfatta hittills** (chat, live): finns från början.

## Koppla en agent (MCP)

Mottagaren är också en MCP-server, så att en AI-agent kan läsa och söka i snacken. Adressen är
`https://<din-adress>/mcp` (Streamable HTTP, statelös) och den står också i upptäckten som `mcp`. Det finns två sätt
att logga in:

- **Agentnyckel** (`ssk_agent_…`) för Claude Code, Cursor och andra klienter där man kan sätta ett huvud: man går till
  sajten och hämtar en nyckel som är unik för användaren och agenten. Nycklarna sparas bara som SHA-256 och visas en gång.
- **OAuth** för claude.ai och andra klienter som bara tar en adress: klienten registrerar sig själv och öppnar en
  inloggningssida på mottagaren. Se [claude.ai](#claudeai) nedan.

**Ägaren:** under **Agenter** i admin skapar du en nyckel per agent (till exempel "Claude Code på jobbdatorn"). Den ser
alla snack. Listan visar när varje nyckel senast användes, och en nyckel kan spärras när som helst. Där finns också
avsändarnas nycklar och knappen **Bygg om sökindexet** (för snack som kom in innan sökningen fanns).

**En avsändare:** varje avsändare har en personlig sida, `/min/<token>`. Länken visas under **Avsändare** (med en
kopiera-knapp och **Byt länk**) och på sidan med QR-koden som "Din sida". Länken är inloggningen, så den ska inte delas.
Där skapar avsändaren nycklar för sina agenter och ser kommandona. En avsändares nyckel ser bara dennes egna snack, och
spärras avsändaren slutar också dennes agentnycklar att fungera.

Claude Code:

```sh
claude mcp add --transport http snicksnack https://<din-adress>/mcp --header "Authorization: Bearer <agentnyckel>"
```

Cursor och andra klienter som läser `mcpServers`:

```json
{ "mcpServers": { "snicksnack": { "url": "https://<din-adress>/mcp", "headers": { "Authorization": "Bearer <agentnyckel>" } } } }
```

### claude.ai

I Claude (webben eller appen): **Inställningar → Kopplare → Lägg till egen kopplare**. Namn: Snicksnack, URL:
`https://<din-adress>/mcp`. Lämna client id och client secret tomma. Claude öppnar mottagarens inloggningssida, som
visar klientens namn och vad den får se. Logga in på ett av två sätt:

- **Som ägare** med adminlösenordet (eller bara **Godkänn** om du redan är inloggad i admin i samma webbläsare). Kopplingen
  ser alla snack, som ägarens agentnycklar.
- **Som avsändare** genom att klistra in länken till Din sida (`/min/<token>`) eller en av dina agentnycklar. Kopplingen
  ser bara dina egna snack.

**Avslå** skickar tillbaka till Claude utan att koppla. Inloggningarna syns under **Inloggade klienter**: ägaren ser alla
under Agenter i admin, en avsändare sina egna på sin sida. Båda kan återkalla; klienten slutar då fungera direkt.

Hur det fungerar: `/mcp` svarar `401` med `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
Klienten hittar där servermetadatan (`/.well-known/oauth-authorization-server`), registrerar sig på `/register` (RFC 7591,
publik klient utan hemlighet), skickar användaren till `/authorize` med PKCE (bara `S256`) och byter koden mot tokens
på `/token`. Redirect-adresser får vara https, http till `localhost`/`127.0.0.1`, eller ett appschema (`cursor://…`).
`resource` (RFC 8707) godtas om den pekar på servern men krävs inte. Access-token (`ssk_oauth_…`) gäller en timme,
refresh-token (`ssk_refresh_…`) 90 dagar och byts vid varje förnyelse. Allt ligger i D1 (`oauth_clients`, `oauth_codes`,
`oauth_grants`, migration 0004) och tokens och koder sparas bara som SHA-256. Spärras en avsändare slutar också dennes
inloggningar att fungera. Formuläret skyddas med en cookie och en token signerad med `KEY_SECRET` (eller
`ADMIN_PASSWORD` om den saknas). Agentnycklar fungerar som förut: ett huvud som börjar med `Bearer ssk_agent_` prövas
som agentnyckel, allt annat som OAuth-token. Mer i [docs/arkitektur.md](docs/arkitektur.md#oauth-flödet-claudeai-och-andra-mcp-klienter).

Verktygen (engelska namn; löptext i svaren är på svenska):

| Verktyg | |
|---|---|
| `list_snacks(target?, sender?, from?, to?, tag?, query?, limit=20, offset=0)` | Snacken, nyast först: titel, id, recorded_at, längd, mål, avsändare, taggar, antal ord. `from`/`to` är datum (`YYYY-MM-DD`). |
| `get_snack(target, sender, id, include?)` | Ett snack: texten med talarprefix vid talarbyte, anteckningen, sammanfattningarna och taggarna. `include` väljer bland `text`, `summaries`, `note`, `words`; orden med tider bara på begäran. |
| `search(query, limit=20)` | Fulltextsök (FTS5) i titel, text, anteckning och sammanfattningar. Alla ord måste finnas, som prefix. Träffar med utdrag och snackets referens. |
| `get_audio_url(target, sender, id)` | En signerad länk till ljudet som gäller en timme (HMAC med `KEY_SECRET`), med Range-stöd. |
| `list_targets()` | Målen, och för ägaren också avsändarna, med antal snack. |

Sökindexet fylls när ett snack tas emot (bara om transkriptet sparas, se `accepts`). Snack som fanns innan läggs in med
**Bygg om sökindexet** under Agenter; det läser transcript.json ur R2.

## Efter mottagning

`src/efter-mottagning.ts` anropas efter varje mottaget snack, med metadata (mål, avsändare, titel, tid, längd,
taggar, filer, länk, om det är nytt eller en omsändning). Den körs efter att svaret skickats till appen och ett fel
där påverkar inte mottagningen. I dag skriver den bara en loggrad.

Det som är tänkt att komma dit: e-post till ägaren när ett snack kommer in, eller en webhook. Det finns inte ännu.

## Bygga en egen mottagare

Appen bryr sig inte om vad som finns bakom adressen. En egen mottagare behöver bara upptäckten, målen och mottagningen
(avsnitt 1–3 i [docs/protokoll.md](docs/protokoll.md)); sammanfattning och chatt är valfria. Protokollet beskriver
varje fält, vad appen gör vid varje statuskod och har curl-exempel att prova med. Den här Workern är ett exempel att
jämföra med: `src/protokoll.ts` är kärnan och `src/ai/anrop.ts` AI-delen.

Prompt till Claude Code för att bygga en egen:

```text
Jag vill bygga en egen mottagare för iOS-appen Snicksnack i <språk/ramverk>, som sparar snacken i <var>.
Läs protokollet i https://github.com/ahlstrominfo/snicksnackserver/blob/main/docs/protokoll.md (hela, inklusive
statuskoderna och avsnittet om saknade värden i transcript.json). Bygg avsnitt 1–3 först: upptäckten, målen och
mottagningen, med en nyckel per avsändare som sparas hashad. Skriv tester som kör curl-exemplen i protokollet mot
servern. Fråga mig innan du lägger till sammanfattning och chatt (avsnitt 4–6).
```

## Prompt till Claude Code

Klistra in det här i [Claude Code](https://claude.com/claude-code) i en tom katalog för att få hjälp att sätta upp
mottagaren på ditt eget konto:

```text
Jag vill sätta upp en egen Snicksnack-mottagare på mitt Cloudflare-konto. Klona
https://github.com/ahlstrominfo/snicksnackserver.git och läs README.md, docs/protokoll.md och SECURITY.md.

Följ avsnittet "Sätta upp på ditt eget Cloudflare-konto" steg för steg:
- kör `npm install` och kopiera wrangler.example.jsonc till wrangler.jsonc,
- kontrollera att jag är inloggad med `npx wrangler whoami` (be mig köra `npx wrangler login` om inte,
  och fråga vilket konto som ska användas om det finns flera; fyll då i account_id i wrangler.jsonc),
- skapa R2-hinken och D1-databasen, lägg in databasens id i wrangler.jsonc och kör `npm run db:migrate:remote`,
- kör `npm test` och sedan `npm run deploy`,
- be mig själv köra `npx wrangler secret put ADMIN_PASSWORD` och
  `openssl rand -base64 48 | npx wrangler secret put KEY_SECRET` så att hemligheterna inte hamnar i din kontext.

Fråga mig om jag vill använda en egen domän; i så fall lägg till den som routes med custom_domain i wrangler.jsonc
och deploya igen. Visa mig till sist adressen till /admin och /.well-known/snicksnack, och förklara hur jag skapar
ett mål och en avsändare och skannar QR-koden i Snicksnack. Ändra inget i koden utöver wrangler.jsonc utan att fråga.
```

## Bidra

Issues och pull requests är välkomna, på svenska eller engelska. Kör `npm test` och `npm run typecheck` innan du
skickar en PR. Säkerhetsproblem: se [SECURITY.md](SECURITY.md).

## Licens

MIT, se [LICENSE](LICENSE). Copyright (c) 2026 Mattias Ahlström.

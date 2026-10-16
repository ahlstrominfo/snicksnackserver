# Snicksnack-mottagare

En öppen referensmottagare för [Snicksnack](https://snicksnack.applicerad.ai), iOS-appen som gör tal till text på
telefonen. Mottagaren är en Cloudflare Worker som tar emot snack (transkript, text och ljud) som skickas från appen
och sparar dem på ditt eget Cloudflare-konto. Den går att köra på gratisplanen.

Tänkt användning: du sätter upp en mottagare och ger nycklar till de personer som ska skicka till dig, till exempel
dina coacher eller kollegor. Var och en får en egen nyckel och ser bara de mål du har gett dem. Det är en installation
per ägare; vill någon annan ha en egen mottagare sätter de upp sin egen.

- **Protokollet** står i [docs/protokoll.md](docs/protokoll.md) (version 1).
- **Filerna** hamnar i en R2-hink: `<mål>/<avsändare>/<snack-id>/transcript.json`, `text.md` och `audio.m4a`
  (eller `audio.wav`).
- **Avsändare, mål och ett index över snacken** ligger i en D1-databas. Nycklarna sparas bara som SHA-256.
- **Admin** finns på `/admin`: inställningar (namn, färg, logga, vad appen ska skicka), mål, avsändare med nyckel och
  QR-kod, och de mottagna snacken med text och nedladdning.

## Adresserna

| | |
|---|---|
| `GET /.well-known/snicksnack` | Upptäckt: namn, version, adresserna, `accepts`, `color`, `icon`. Utan nyckel. |
| `GET /snicksnack/targets` | Målen som avsändaren har tilldelats. `Authorization: Bearer <nyckel>`. |
| `POST /snicksnack/receive/<mål>` | Tar emot ett snack (multipart: `transcript`, `text`, `audio`). Svar `{id, url}`. |
| `GET /icon.png` | Loggan, om du har laddat upp en. |
| `/admin` | Admin, inloggning med lösenordet i `ADMIN_PASSWORD`. |

Statuskoder från protokollet: `401` fel eller spärrad nyckel, `404` okänt mål eller ett mål avsändaren inte har,
`413` för stort, `400` trasig kropp, `5xx` vid fel (appen försöker då igen senare). Alla svar är JSON.

Skickas samma snack igen (samma `Idempotency-Key`) skrivs filerna och indexet över. En del som inte kommer med den
gången (till exempel ljudet) ligger kvar från förra sändningen.

## Sätta upp på ditt eget Cloudflare-konto

Du behöver Node.js 20 eller senare och ett Cloudflare-konto (gratis). R2 måste vara aktiverat i kontot: öppna R2 i
Cloudflares instrumentpanel en gång och följ anvisningarna (Cloudflare kan be om ett betalkort även för
gratisnivån).

1. Hämta koden och installera:

   ```sh
   git clone <adressen till det här repot> snicksnack-mottagare
   cd snicksnack-mottagare
   npm install
   ```

2. Logga in i Cloudflare:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

3. Skapa hinken för filerna:

   ```sh
   npx wrangler r2 bucket create snicksnack-mottagare
   ```

4. Skapa databasen och lägg in dess id i `wrangler.jsonc` (fältet `database_id`, i stället för nollorna). Wrangler
   kan erbjuda sig att göra det själv.

   ```sh
   npx wrangler d1 create snicksnack-mottagare
   ```

5. Skapa tabellerna:

   ```sh
   npm run db:migrate:remote
   ```

6. Deploya och sätt lösenordet för admin:

   ```sh
   npm run deploy
   npx wrangler secret put ADMIN_PASSWORD
   ```

   Wrangler skriver ut adressen, till exempel `https://snicksnack-mottagare.<ditt-namn>.workers.dev`.

7. Öppna `https://<adressen>/admin`, logga in och ställ in namn, färg och logga under **Inställningar**.

### Egen domän (valfritt)

Har du en domän i Cloudflare kan Workern ligga på en egen adress, till exempel `snack.example.se`. Lägg till i
`wrangler.jsonc` och deploya igen:

```jsonc
"routes": [{ "pattern": "snack.example.se", "custom_domain": true }]
```

Det går också att göra under Workers → snicksnack-mottagare → Settings → Domains & Routes. Mottagaren tar sina
adresser från anropet, så well-known pekar rätt oavsett vilken adress som används.

## Lägga till en avsändare

1. Skapa minst ett mål under **Mål** (till exempel "Inkorg"). Id:t går inte att ändra efteråt; det ingår i
   sökvägarna i R2.
2. Under **Avsändare**: skriv personens namn, kryssa i de mål hen ska kunna skicka till och tryck
   **Skapa och visa nyckel**.
3. Sidan visar nyckeln och en QR-kod med `snicksnack://receiver?url=https://<din-adress>&key=<nyckel>`. Nyckeln visas
   bara den här gången. Be personen lägga till en mottagare i Snicksnack och skanna koden, eller skicka länken.
4. Tappas nyckeln bort: tryck **Ny nyckel** (den gamla slutar fungera). **Spärra** tar bort nyckeln direkt;
   snacken som redan kommit in ligger kvar.

De mottagna snacken finns under **Snack**, filtrerbara per mål och avsändare. Länken som appen visar efter en
sändning går till snackets sida i admin.

## Köra lokalt

`wrangler dev` kör allt lokalt med lokal R2 och D1 (i `.wrangler/`), utan anrop till Cloudflare.

```sh
npm install
cp .dev.vars.example .dev.vars     # sätt ADMIN_PASSWORD
npm run seed                       # skapar tabellerna, målet "inbox" och en avsändare; skriver ut nyckeln
npm run dev                        # http://localhost:8787
```

Prova med curl (byt `$NYCKEL` mot nyckeln från `npm run seed`):

```sh
curl http://localhost:8787/.well-known/snicksnack
curl -H "Authorization: Bearer $NYCKEL" http://localhost:8787/snicksnack/targets
curl -H "Authorization: Bearer $NYCKEL" -H "Idempotency-Key: prov-1" \
  -F "transcript=@transcript.json;type=application/json" \
  -F "text=@prov.md;type=text/markdown" \
  -F "audio=@prov.m4a;type=audio/mp4" \
  http://localhost:8787/snicksnack/receive/inbox
```

iOS-simulatorn når `http://localhost:8787` direkt. En telefon på samma nät når datorn med
`npx wrangler dev --ip 0.0.0.0` och `http://<datorns-ip>:8787`; appen tillåter http bara till lokala nät.

Tester: `npm test` (vitest i Workers-miljön, med lokal R2 och D1). Typer: `npm run typecheck`.

## Begränsningar

- **100 MB per sändning.** Workers tar emot högst 100 MB i en kropp på gratis- och Pro-planen; större anrop stoppas
  av Cloudflare innan de når Workern, och appen får `413`. Ljud i Apple Lossless tar ungefär 66 MB per timme, så
  ett snack på mer än en och en halv timme går inte att skicka med ljud. Stäng av ljudet under **Inställningar**
  om du bara behöver texten.
- **Minnet.** En Worker har 128 MB minne och mottagaren läser hela kroppen innan den sparas. Sändningar nära
  100 MB kan därför misslyckas; appen försöker då igen senare.
- **R2 gratis:** 10 GB lagring per månad (och ett generöst antal anrop). Ett timslångt snack med ljud är ungefär
  66 MB, så det räcker till runt 150 timmar ljud. Utan ljud är snacken några hundra kB.
- **D1 och Workers gratis:** 5 GB databas och 100 000 anrop per dygn, mer än nog här.
- Listan över snack i admin visar de 500 senaste per urval.

## Efter mottagning

`src/efter-mottagning.ts` anropas efter varje mottaget snack, med metadata (mål, avsändare, titel, tid, längd,
taggar, filer, länk, om det är nytt eller en omsändning). Den körs efter att svaret skickats till appen och ett fel
där påverkar inte mottagningen. I dag skriver den bara en loggrad.

Det som är tänkt att komma dit: e-post till ägaren när ett snack kommer in, och en MCP-server så att en AI-assistent
kan söka i och läsa de mottagna snacken. Inget av det finns ännu.

## Prompt till Claude Code

Klistra in det här i [Claude Code](https://claude.com/claude-code) i en tom katalog för att få hjälp att sätta upp
mottagaren på ditt eget konto:

```text
Jag vill sätta upp en egen Snicksnack-mottagare på mitt Cloudflare-konto. Klona
<adressen till det här repot> och läs README.md och docs/protokoll.md.

Följ avsnittet "Sätta upp på ditt eget Cloudflare-konto" steg för steg:
- kontrollera att jag är inloggad med `npx wrangler whoami` (be mig köra `npx wrangler login` om inte,
  och fråga vilket konto som ska användas om det finns flera),
- skapa R2-hinken och D1-databasen, lägg in databasens id i wrangler.jsonc och kör migreringen,
- deploya, och be mig sedan själv köra `npx wrangler secret put ADMIN_PASSWORD` så att lösenordet inte
  hamnar i din kontext,
- kör `npm test` innan du deployar.

Fråga mig om jag vill använda en egen domän; i så fall lägg till den som custom domain i wrangler.jsonc.
Visa mig till sist adressen till /admin och /.well-known/snicksnack, och förklara hur jag skapar ett mål och
en avsändare och skannar QR-koden i Snicksnack. Ändra inget i koden utöver wrangler.jsonc utan att fråga.
```

## Licens

MIT, se [LICENSE](LICENSE). Copyright (c) 2026 Mattias Ahlström.

# Snicksnack-protokollet, version 1

Det här är allt en server behöver för att ta emot snack från iOS-appen Snicksnack. Det är skrivet för den som vill
bygga en egen mottagare i valfri teknik; referensmottagaren i det här repot (en Cloudflare Worker) är ett exempel.

Snicksnack skickar ett snack (transkript, text och ljud) till en server som användaren pekar ut. Appen är bara en
avsändare: den vet vad den skickar och vart. Vad servern gör med det är serverns sak. Protokollets identifierare
och fältnamn är på engelska, beskrivningen på svenska.

**Krav och val.** *Krävs* betyder att appen inte fungerar mot servern utan det. *Valfritt* betyder att appen klarar sig
utan det. *Ska* gäller servern: appen räknar med det. Avsnitt 1–3 är kärnan; 4–6 (extern AI) är valfria i sin helhet.

## Innehåll

- [Kedjan](#kedjan)
- [Gemensamt: adresser, nyckel, fel](#gemensamt-adresser-nyckel-fel)
- [1. Upptäckt: `GET /.well-known/snicksnack`](#1-upptäckt-get-well-knownsnicksnack)
- [2. Mål: `GET <targets>`](#2-mål-get-targets)
- [3. Ta emot: `POST <receive>/<id>`](#3-ta-emot-post-receiveid)
- [transcript.json](#transcriptjson)
- [4. Prompter: `GET <summarize>`](#4-prompter-get-summarize)
- [5. Sammanfatta: `POST <summarize>/<prompt-id>`](#5-sammanfatta-post-summarizeprompt-id)
- [6. Chatt: `POST <chat>`](#6-chatt-post-chat)
- [QR-koden](#qr-koden)
- [Statuskoder och vad appen gör](#statuskoder-och-vad-appen-gör)
- [Prova en server med curl](#prova-en-server-med-curl)
- [Referensmottagarens tillägg och val](#referensmottagarens-tillägg-och-val)

## Kedjan

1. **Upptäckt.** Användaren anger en adress (eller skannar en QR-kod). Appen hämtar
   `<adress>/.well-known/snicksnack`, som säger vad servern heter och var de andra anropen finns.
2. **Mål.** Appen hämtar målen (`targets`): id och namn. Användaren väljer ett när hen skickar.
3. **Ta emot.** Appen postar snacket till `<receive>/<mål-id>`.
4. **Nyckel.** Servern utfärdar en API-nyckel som användaren får som QR-kod eller text. Appen skickar den som
   `Authorization: Bearer <nyckel>` i alla anrop utom upptäckten och loggan.
5. **Extern AI (valfritt).** Servern kan sammanfatta snack med sina egna prompter (4, 5) och svara på frågor om dem i
   en chatt (6), också medan snacket spelas in.

## Gemensamt: adresser, nyckel, fel

- **Adressen** användaren anger normaliseras så här: saknas schema läggs `https://` till, avslutande `/` tas bort.
  En sökväg behålls, så `https://example.se/snack` ger upptäckten `https://example.se/snack/.well-known/snicksnack`.
- **https krävs**, utom till lokala nät (`localhost`, `*.local`, namn utan punkt, 10/8, 172.16/12, 192.168/16,
  169.254/16, 127/8, `::1`, `fe80::/10`, `fc00::/7`). Där går http, så en hemmaserver eller `wrangler dev` fungerar.
  Samma regel gäller loggan.
- **Nyckeln** är en sträng som servern väljer. Appen sparar den i iOS-nyckelringen och skickar den bara till sin egen
  server. Den kan innehålla vilka tecken som helst som går i ett HTTP-huvud; undvik mellanslag.
- **Nyckeln är avsändarens identitet.** En server kan ha flera avsändare, en nyckel per person, och visa olika mål och
  prompter för olika nycklar. transcript.json har inget avsändarfält: servern vet vem som skickade av nyckeln.
- **Felsvar** ska helst vara JSON, `{"error": "text för människor"}`. Appen visar texten för användaren vid AI-anropen
  och de första 300 tecknen av kroppen vid övriga fel. Se [Statuskoder](#statuskoder-och-vad-appen-gör).
- **Tidsgränser i appen:** 60 s utan data för upptäckt, mål och mottagning (en sändning får hålla på i upp till en
  timme totalt), 300 s för sammanfattning och chatt.

## 1. Upptäckt: `GET /.well-known/snicksnack`

Utan nyckel. Svar `200` med `application/json`:

```json
{
  "name": "Exempelbolaget",
  "version": 1,
  "auth": "api-key",
  "targets": "https://snack.example.se/snicksnack/targets",
  "receive": "https://snack.example.se/snicksnack/receive",
  "accepts": ["audio", "transcript", "text"],
  "key_url": "https://snack.example.se/nyckel",
  "color": "#E27B48",
  "icon": "https://snack.example.se/icon.png?v=1",
  "summarize": "https://snack.example.se/snicksnack/summarize",
  "chat": "https://snack.example.se/snicksnack/chat"
}
```

| Fält | | Typ | |
|---|---|---|---|
| `name` | krävs | sträng | Serverns namn som det visas i appen. |
| `version` | krävs | heltal | Protokollversion. Appen godtar bara `1` och säger annars att servern använder en okänd version. |
| `auth` | krävs | sträng | `"api-key"` i version 1. Något annat avvisas. |
| `targets` | krävs | absolut URL | Listan över mål (2). |
| `receive` | krävs | absolut URL | Mottagningen (3); appen lägger på `/<mål-id>`. |
| `accepts` | valfritt | lista med strängar | Delarna servern vill ha: `audio`, `transcript`, `text`. Saknas = alla. Appen skickar inte `text` eller `audio` om de saknas här (ljudet är stort); `transcript` skickas alltid. |
| `key_url` | valfritt | absolut URL | Sida där användaren kan hämta en nyckel. |
| `color` | valfritt | sträng | Serverns färg som hex, `"#E27B48"` (# och exakt sex hexsiffror). Appen använder den som accent för mottagarens post och tonar den själv för ljust och mörkt läge. |
| `icon` | valfritt | absolut URL | Serverns logga, se nedan. |
| `summarize` | valfritt | absolut URL | Prompterna (4) och sammanfattningarna (5); appen lägger på `/<prompt-id>`. Saknas = servern har ingen extern AI, och appen hämtar inga prompter (inte heller chattens). |
| `chat` | valfritt | absolut URL | Chatten (6). Saknas = ingen chatt. |

Okända fält ignoreras, så en server kan lägga till egna (se [tilläggen](#referensmottagarens-tillägg-och-val)).

Saknas `color` och `icon` visar appen sin vanliga bubbla och namnet. En ogiltig färg, en logga som inte går att hämta
och en trasig adress i `icon`, `summarize` eller `chat` behandlas som att fältet saknas. Är däremot `targets` eller
`receive` trasiga, eller svaret inte `200` med giltig JSON, säger appen att det inte finns någon mottagare på adressen.

**Loggan (`icon`).** PNG, kvadratisk, minst 256 px, gärna genomskinlig bakgrund, högst 2 MB. Inte SVG (iOS kan inte
rita SVG från nätet). Appen hämtar den utan nyckel, kräver svar `200`, kontrollerar PNG-signaturen och avbryter vid
mer än 2 MB. Den hämtas en gång och sparas; den hämtas igen bara när adressen ändras. Byter du logga: byt adressen
(till exempel `?v=<version>`), annars ser användarna den gamla.

**När appen läser upptäckten:** när mottagaren läggs till, och igen när användaren uppdaterar listan över mål. Namn,
`accepts`, färg, logga och AI-adresserna uppdateras då.

`.well-known` är en katalog (RFC 8615): varje tjänst har sitt eget namn under den, så `snicksnack` ligger bredvid till
exempel `oauth-protected-resource` utan att krocka.

## 2. Mål: `GET <targets>`

Med nyckel. Svar `200`:

```json
{
  "targets": [
    { "id": "umea-energi", "name": "Umeå Energi", "group": "Kunder" },
    { "id": "inbox", "name": "Inkorg" }
  ]
}
```

| Fält | | Typ | |
|---|---|---|---|
| `targets` | krävs | lista | Målen den här nyckeln får skicka till. Tom lista är tillåten. |
| `targets[].id` | krävs | sträng | Serverns identifierare. Helst URL-säker; appen procentkodar den i sökvägen. |
| `targets[].name` | krävs | sträng | Visas för användaren. |
| `targets[].group` | valfritt | sträng | Delar upp listan i grupper. |

Listan är platt i version 1. Servern bestämmer vad ett mål betyder: kund, projekt, mapp, person.

Appen hämtar listan när mottagaren läggs till, när användaren uppdaterar den och när en sändning fått `404`.
`401` och `403` betyder ogiltig nyckel: appen slutar skicka till servern tills användaren byter nyckel.

## 3. Ta emot: `POST <receive>/<id>`

Med nyckel. `<id>` är målets id, procentkodat. Huvuden:

| Huvud | | |
|---|---|---|
| `Authorization` | krävs | `Bearer <nyckel>`. |
| `Idempotency-Key` | skickas alltid | Snackets id, samma som `transcript.id`. Stabilt för snacket. |
| `Content-Type` | skickas alltid | `multipart/form-data; boundary=snicksnack-<uuid>`. |

Kroppen är `multipart/form-data` med upp till tre delar. Varje del har `filename` och en egen `Content-Type`:

| Del (`name`) | `Content-Type` | `filename` | Innehåll |
|---|---|---|---|
| `transcript` | `application/json` | `transcript.json` | Snacket som data, se [transcript.json](#transcriptjson). Skickas alltid. |
| `text` | `text/markdown; charset=utf-8` | `<rubrik>.md` | Samma som appens markdown-export: rubrik, datum, sammanfattningar, transkript per talare. Bara om `accepts` innehåller `text`. |
| `audio` | `audio/mp4` eller `audio/wav` | `<snack-id>.m4a` eller `<snack-id>.wav` | Ljudet. Bara om `accepts` innehåller `audio` och snacket har kvar sitt ljud. |

Servern **ska tåla att `text` och `audio` saknas**, och bör tåla att `transcript` saknas.

**Ljudet** är Apple Lossless (ALAC) i en MPEG-4-behållare (`.m4a`), 16 kHz, mono, 16 bitar. Det tar ungefär 60–70 MB
per timme. Äldre snack kan ha okomprimerat ljud i `.wav`, som är flera gånger större. Hela kroppen kan alltså bli
stor: planera för minst 100 MB per sändning om ljudet ska med (`413` om servern inte klarar det, se nedan).

**Samma snack kan skickas igen** (användaren har döpt, taggat eller kört om det). Servern ska då uppdatera, inte
dubblera: `transcript.id` och `Idempotency-Key` är desamma. Hur servern gör det är upp till den; referensmottagaren
skriver över filerna och låter delar som inte kom med den gången ligga kvar.

Svar `2xx` (`200` eller `201`) med `application/json`:

```json
{ "id": "inbox/anna/20261010T093012", "url": "https://snack.example.se/admin/snack/inbox/anna/20261010T093012" }
```

| Fält | | |
|---|---|---|
| `id` | valfritt | Serverns id för snacket. Appen använder det inte i dag. |
| `url` | valfritt | En länk som appen visar efter sändningen ("Skickat till Inkorg, öppna"). |

Ett tomt eller annorlunda svar med `2xx` räknas också som lyckat.

**Kön i appen.** En sändning ligger kvar tills den lyckas. Nätfel och `5xx` görs om efter 1, 2, 4, 8 … minuter (högst
60), och när appen blir aktiv eller nätet kommer tillbaka. `401`/`403` stoppar alla sändningar till servern tills
användaren byter nyckel. `404`, `413` och alla andra `4xx` gör att appen ger upp sändningen (användaren kan försöka
igen för hand); vid `404` hämtar appen dessutom listan över mål igen.

## transcript.json

```json
{
  "format": "snicksnack-transcript",
  "version": 1,
  "id": "20261010T093012",
  "title": "Styrgrupp om fjärrvärmen",
  "recorded_at": "2026-10-10T09:30:12+02:00",
  "duration": 1834.2,
  "language": "sv",
  "tags": ["styrgrupp", "fjärrvärme"],
  "note": "Användarens egen anteckning",
  "quick_note": false,
  "speakers": { "0": "Anna", "1": "Talare 2" },
  "speakers_hidden": false,
  "text": "Hela texten som ett stycke …",
  "words": [
    { "text": "Vi", "start": 0.32, "end": 0.48, "speaker": 0 },
    { "text": "börjar.", "start": 0.51, "end": 0.9, "speaker": 0 }
  ],
  "summaries": [
    {
      "kind": "decisions",
      "created_at": "2026-10-10T10:02:40+02:00",
      "items": [
        { "section": "Beslut", "text": "Taxan höjs med 3 % från januari.", "speaker": 1, "at": 412.5 }
      ]
    },
    {
      "kind": "custom",
      "name": "Coachrapport",
      "prompt": "coachrapport",
      "source": "Exempelbolaget",
      "created_at": "2026-10-10T10:05:00+02:00",
      "items": [{ "section": "Nästa steg", "text": "Skicka offerten i morgon." }]
    }
  ],
  "parts": [],
  "app": { "name": "Snicksnack", "version": "2.1 (9)", "model": "pianissimo-sv-coreml-int8-v1" }
}
```

**Saknade värden.** Appen utelämnar fält som saknar värde i stället för att skriva `null` (till exempel `note`,
`words[].speaker`, `items[].speaker`, `items[].at`, `parts[].title`). En server ska behandla ett fält som saknas och
ett fält som är `null` likadant. Nycklarna kommer i alfabetisk ordning; servern ska inte bry sig om ordningen.

| Fält | Typ | |
|---|---|---|
| `format` | sträng | Alltid `"snicksnack-transcript"`. |
| `version` | heltal | Filformatets version, `1`. |
| `id` | sträng | Snackets id i appen. Stabilt: samma vid omsändning, samma som `Idempotency-Key`. I dag på formen `20261010T093012`, men behandla det som en godtycklig sträng. |
| `title` | sträng | Rubriken. |
| `recorded_at` | sträng | När inspelningen började, ISO 8601 med tidszon. |
| `duration` | tal | Längd i sekunder. Under en pågående inspelning (5, 6): så långt inspelningen kommit. |
| `language` | sträng | ISO 639-1 (`sv`, `en`, `da`, `fi`, `de` …). |
| `tags` | lista med strängar | Användarens taggar. Kan vara tom. |
| `note` | sträng, kan saknas | Användarens egen anteckning. |
| `quick_note` | boolesk | En snabbanteckning (appen skickar dem aldrig automatiskt). |
| `speakers` | objekt | Talar-id (som sträng) → namn. Id utan namn får "Talare N" (N = id + 1, på appens språk). Tomt när talarna inte är igenkända. |
| `speakers_hidden` | boolesk | Användaren har dolt talarna i visningen; `words[].speaker` finns ändå. |
| `text` | sträng | Hela texten. Finns alltid, också när `words` är tom. |
| `words` | lista | Varje ord: `text` (sträng, skiljetecken sitter kvar), `start` och `end` (sekunder från start), `speaker` (heltal, kan saknas). Tom lista för gamla snack utan ordtider. |
| `summaries` | lista | Sammanfattningarna, äldst först, se nedan. |
| `summaries[].kind` | sträng | Appens egna: `short`, `decisions`, `minutes`, `quotes`. Från en mottagare: `custom`. Okända sorter kan förekomma. |
| `summaries[].created_at` | sträng | ISO 8601 med tidszon. |
| `summaries[].items` | lista | Punkterna: `section` (rubriken punkten visas under, som "Sammanfattning", "Beslut", "Att göra", "Frågor", "Citat"), `text`, `speaker` (heltal, kan saknas), `at` (sekund i inspelningen där punkten har sin källa, kan saknas). |
| `summaries[].name`, `.prompt`, `.source` | sträng | Bara för `custom`: promptens namn, promptens id och mottagarens namn. |
| `parts` | lista | Bara för sammanslagna snack: `start` och `duration` (sekunder i den gemensamma tidslinjen), `recorded_at`, `title` (kan saknas). Annars tom. |
| `app` | objekt | `name`, `version` och `model` (taligenkänningsmodellen). För felsökning. |

## 4. Prompter: `GET <summarize>`

Valfritt. Med nyckel. Vad servern kan göra med ett snack, filtrerat per nyckel. Svar `200`:

```json
{
  "prompts": [
    { "id": "coachrapport", "name": "Coachrapport", "description": "Styrkor och nästa steg för säljaren", "kind": "summary", "live": false },
    { "id": "hittills", "name": "Sammanfatta hittills", "description": "Vad har sagts hittills?", "kind": "chat", "live": true }
  ]
}
```

| Fält | | Typ | |
|---|---|---|---|
| `id` | krävs | sträng | Serverns identifierare. Helst URL-säker; appen procentkodar den. |
| `name` | krävs | sträng | Visas i appen: som val vid Sammanfatta, eller som användarens bubbla i chatten. |
| `description` | valfritt | sträng | En rad under namnet. |
| `kind` | krävs | sträng | `summary`: en sammanfattning (5). `chat`: en färdig fråga i chatten (6). Prompter med okänd sort (eller som inte går att tolka) hoppar appen över; resten gäller. |
| `live` | valfritt | boolesk | Får användas medan snacket spelas in, på texten hittills. Saknas = `false`. |

Listan innehåller båda sorterna, så **en server med chatt men utan sammanfattningar behöver ändå `summarize`** i
upptäckten för att appen ska hitta chattens prompter.

Appen hämtar listan när mottagaren läggs till, när målen uppdateras och efter en `404` från 5 eller 6. Ett fel här
stoppar inte kopplingen: appen behåller den förra listan. Appen visar Sammanfatta när det finns minst en prompt med
`summary`, och chatten när `chat` finns i upptäckten (egna frågor går då alltid att skriva).

## 5. Sammanfatta: `POST <summarize>/<prompt-id>`

Valfritt. Med nyckel, `Content-Type: application/json`. Kroppen är transcript.json, samma som i mottagningen (3).
Under en pågående inspelning är det texten hittills: `duration` är så långt inspelningen kommit och `words` saknar
talare. Appen använder bara prompter med `live: true` under inspelning.

Svaret är synkront och får ta tid; appen väntar upp till 300 s. Svar `200`:

```json
{
  "summary": {
    "kind": "custom",
    "name": "Coachrapport",
    "prompt": "coachrapport",
    "created_at": "2026-10-17T10:02:40+02:00",
    "items": [
      { "section": "Styrkor", "text": "Frågorna: säljaren lät kunden prata klart.", "speaker": 0, "at": 12.3 },
      { "section": "Citat", "text": "Vi behöver det här före jul.", "speaker": 1, "at": 412.5 },
      { "section": "Nästa steg", "text": "Skicka offerten i morgon.", "speaker": null, "at": null }
    ]
  },
  "markdown": "## Styrkor\n\n- Frågorna: säljaren lät kunden prata klart.\n…"
}
```

| Fält | | |
|---|---|---|
| `summary.items` | krävs | Punkterna, samma form som `summaries[].items` i transcript.json. `section` och `text` krävs; `speaker` och `at` får vara `null` eller saknas. Punkter med tom text hoppas över. |
| `summary.name` | valfritt | Visas som sammanfattningens namn. Saknas = promptens namn. |
| `summary.created_at` | valfritt | ISO 8601. Saknas = när svaret kom. |
| `summary.kind`, `summary.prompt` | valfritt | Appen sätter själv `custom` och promptens id. |
| `markdown` | valfritt | Sparas som den är. |

**Citat.** Punkter i ett avsnitt som börjar med "Citat" (eller "Quote") ska vara ordagranna. Appen tar bort
citattecken runt texten, letar upp den bland orden, sätter `at` och talare från första ordet och markerar citat som
inte finns ordagrant.

Appen sparar svaret på snacket som en sammanfattning med `kind: custom` och mottagarens namn som `source`. Den följer
sedan med i transcript.json vid nästa sändning.

## 6. Chatt: `POST <chat>`

Valfritt. Med nyckel, `Content-Type: application/json`, `Accept: text/event-stream`. Kroppen:

```json
{
  "prompt": "hittills",
  "messages": [
    { "role": "user", "content": "Vem lovade att skicka offerten?" },
    { "role": "assistant", "content": "Anna, i slutet av mötet." }
  ],
  "transcript": { "format": "snicksnack-transcript", "version": 1, "…": "…" },
  "live": true
}
```

| Fält | Typ | |
|---|---|---|
| `prompt` | sträng eller `null` | Alltid med. En prompt med `kind: chat`, eller `null`. Är den satt ska servern själv lägga till promptens fråga som sista användarmeddelande (appen visar promptens namn som användarens bubbla). Annars är sista meddelandet i `messages` frågan. |
| `messages` | lista | Historiken, äldst först, `user` och `assistant` om vartannat. Chatten är statelös: appen skickar allt varje gång. En tidigare prompt står i historiken med sitt namn som `content`. En fråga som inte fick något svar skickas inte igen. Kan vara tom när `prompt` är satt. |
| `transcript` | objekt | transcript.json, som i (3) och (5). |
| `live` | boolesk | Snacket spelas in just nu; `transcript` är texten hittills. |

Svar `200` med `Content-Type: text/event-stream`. Varje händelse är en rad `data: <JSON på en rad>` följd av en tom rad:

```
data: {"status":"Läser transkriptet"}

data: {"content":"Anna lovade "}

data: {"content":"att skicka den i morgon."}

data: {"done":true}
```

| Händelse | |
|---|---|
| `{"content": "…"}` | Nästa bit av svaret. Appen visar bitarna i takt med att de kommer. |
| `{"status": "…"}` | Valfri statusrad som appen visar medan den väntar. |
| `{"done": true}` | Svaret är klart. Appen slutar läsa. |
| `{"error": "…"}` | Fel mitt i strömmen. Appen visar texten och sparar inte svaret. |

Rader som inte börjar med `data:` och data som inte är JSON hoppas över, så kommentarer (`: ping`) går bra för att
hålla anslutningen vid liv. Stängs strömmen utan `done` räknas det som klart om något svar kommit. Ett svar utan
någon `content` räknas som fel. Avbryter användaren slutar appen läsa och stänger anslutningen.

Fel före strömmen är vanliga statuskoder med JSON, `{"error": "…"}`, se nedan.

Chatten sparas i appen (i snackets mapp); servern behöver inte spara något.

## QR-koden

Servern kan ge användaren en QR-kod eller en länk med adressen och nyckeln:

```
snicksnack://receiver?url=https://snack.example.se&key=<nyckel>
```

`url` är adressen som i [Gemensamt](#gemensamt-adresser-nyckel-fel) och `key` nyckeln (procentkodad om den har
specialtecken). Utan `key` frågar appen efter nyckeln. Användaren kan också skriva in adressen för hand.

## Statuskoder och vad appen gör

**Upptäckt, mål och mottagning (1–3):**

| Status | Appen |
|---|---|
| `2xx` | Lyckades. |
| `401`, `403` | Ogiltig nyckel. Mottagaren markeras och inget skickas dit förrän användaren byter nyckel. |
| `404` | Målet finns inte längre. Sändningen ges upp och målen hämtas igen. |
| `413` | För stort. Sändningen ges upp och användaren får veta det. |
| övriga `4xx` | Sändningen ges upp; användaren ser status och de första 300 tecknen av kroppen. |
| `5xx`, nätfel | Försöker igen senare (1, 2, 4 … 60 min). |

Upptäckten som inte svarar `200` med giltig JSON ger "ingen mottagare på adressen".

**Prompter, sammanfattning och chatt (4–6):**

| Status | Appen |
|---|---|
| `401`, `403` | Ogiltig nyckel, som ovan. |
| `404` | Prompten finns inte (längre). Appen hämtar prompterna igen. |
| `413` | Snacket är för långt för mottagaren. |
| `502`, `504` | Mottagarens AI gav inget giltigt svar; `error` visas om det finns. |
| övriga | "Servern svarade <kod>: <error>". |

AI-anropen köas inte: nätfel visas direkt och användaren får försöka igen.

## Prova en server med curl

Byt `$BAS` mot serverns adress och `$NYCKEL` mot en nyckel.

```sh
# Upptäckt (utan nyckel)
curl $BAS/.well-known/snicksnack

# Målen
curl -H "Authorization: Bearer $NYCKEL" $BAS/snicksnack/targets

# Ett minimalt snack
cat > transcript.json <<'JSON'
{"format":"snicksnack-transcript","version":1,"id":"prov-1","title":"Prov","recorded_at":"2026-10-17T10:00:00+02:00",
 "duration":2.5,"language":"sv","tags":[],"quick_note":false,"speakers":{"0":"Anna"},"speakers_hidden":false,
 "text":"Hej. Vi börjar.","words":[{"text":"Hej.","start":0.1,"end":0.5,"speaker":0},{"text":"Vi","start":0.9,"end":1.1,"speaker":0},
 {"text":"börjar.","start":1.1,"end":1.6,"speaker":0}],"summaries":[],"parts":[],"app":{"name":"curl","version":"1","model":"-"}}
JSON
printf '# Prov\n\nHej. Vi börjar.\n' > prov.md

# Ta emot (lägg till -F "audio=@prov.m4a;type=audio/mp4" för ljud)
curl -H "Authorization: Bearer $NYCKEL" -H "Idempotency-Key: prov-1" \
  -F "transcript=@transcript.json;type=application/json" \
  -F "text=@prov.md;type=text/markdown" \
  $BAS/snicksnack/receive/inbox

# Prompterna, en sammanfattning och en chattfråga (strömmad)
curl -H "Authorization: Bearer $NYCKEL" $BAS/snicksnack/summarize
curl -H "Authorization: Bearer $NYCKEL" -H "Content-Type: application/json" --data-binary @transcript.json \
  $BAS/snicksnack/summarize/kort-sammanfattning
curl -N -H "Authorization: Bearer $NYCKEL" -H "Content-Type: application/json" \
  -d "{\"prompt\":null,\"messages\":[{\"role\":\"user\",\"content\":\"Vad handlade det om?\"}],\"transcript\":$(cat transcript.json),\"live\":false}" \
  $BAS/snicksnack/chat
```

Adresserna ovan är referensmottagarens; en annan server tar dem från sin upptäckt.

## Referensmottagarens tillägg och val

Det här gäller Workern i det här repot, inte protokollet. En annan server kan göra annorlunda.

- **Adresser:** `/snicksnack/targets`, `/snicksnack/receive/<mål>`, `/snicksnack/summarize[/<prompt>]`,
  `/snicksnack/chat` och `/icon.png?v=<version>`. Upptäckten använder anropets egen origin, så den pekar rätt på
  workers.dev, en egen domän och `localhost`.
- **Upptäckten** har inget `key_url`. `summarize` finns när det finns minst en prompt av sorten `summary` och `chat`
  när det finns minst en av sorten `chat` (sett över alla prompter, inte per nyckel). En installation med bara
  chattprompter skickar alltså inget `summarize`, och appen hittar då inte chattens prompter (se avsnitt 4).
- **`mcp` och `mcp_auth`** (tillägg som appen ignorerar): `mcp` är den absoluta adressen till MCP-servern för agenter
  (Streamable HTTP), `mcp_auth` är `["api-key", "oauth"]`. `api-key` betyder en agentnyckel som
  `Authorization: Bearer ssk_agent_…`; `oauth` betyder OAuth 2.1 enligt MCP:s specifikation (resursmetadata på
  `/.well-known/oauth-protected-resource`, servermetadata på `/.well-known/oauth-authorization-server`, dynamisk
  registrering och PKCE). Se README, "Koppla en agent (MCP)".
- **Mottagning:** `404` både när målet inte finns och när nyckeln inte har tilldelats målet. `400` när kroppen inte är
  multipart, när `transcript` inte är ett JSON-objekt, eller när både `Idempotency-Key` och `transcript.id` saknas.
  Svar `201` för ett nytt snack och `200` för en omsändning. `413` över `MAX_BYTES` (100 MB som standard). Delar som
  inte finns i serverns `accepts` sparas inte även om de skickas. Snackets id rensas till `[A-Za-z0-9._-]`.
- **Sammanfattning och chatt:** `400` om en sammanfattningsprompt används i chatten eller tvärtom, om en prompt utan
  `live` används med `live: true`, eller om sista meddelandet inte är användarens. En fri fråga (`prompt: null`) kräver
  att nyckeln har minst en chattprompt (annars `404`). Modellens svar valideras; följer det inte formen görs anropet om
  en gång, annars `502`. Fel hos AI-leverantören blir `502` (eller `500` när nyckeln saknas eller inte går att läsa).
  `413` över `AI_MAX_BYTES` (20 MB). Chatten skickar `content`, `done` och `error`, men ingen `status`.

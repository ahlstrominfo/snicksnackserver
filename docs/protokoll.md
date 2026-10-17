> Kopia av `docs/mottagare.md` i Snicksnack-repot (ahlstrominfo/snicksnack, gren 1.2, commit 2dd208e, hämtad 2026-10-17).
> Originalet gäller om de skiljer sig. Avsnitten om appens sida och motorn gäller appen, inte servern.
> Fälten `summarize` och `chat` och avsnitten 4–6 (extern AI, beslutat 2026-10-17) är tillagda här efter samma
> beslut som appen följer; de fanns ännu inte i originalet när kopian gjordes.

# Mottagare: skicka snack till en server

Snicksnack kan skicka ett snack (ljud, transkript och text) till en server som användaren pekar ut.
Appen är bara en avsändare: den vet vad den skickar och vart. Vad servern gör med det är serverns sak.
Protokollet är på engelska (identifierare, fältnamn), beskrivningen här på svenska. Version 1.

## Kedjan

1. **Upptäckt.** Användaren anger en domän (eller skannar en QR-kod). Appen hämtar
   `https://<domän>/.well-known/snicksnack`, som säger vad servern heter och var de två anropen finns.
2. **Lista.** Appen hämtar målen (`targets`): id och namn. Användaren väljer ett.
3. **Ta emot.** Appen postar snacket till `receive/<id>`.
4. **Nyckel.** Servern utfärdar en API-nyckel som användaren får som QR-kod eller text. Appen skickar den som
   `Authorization: Bearer <nyckel>` i alla anrop utom upptäckten.

## 1. Upptäckt: `GET /.well-known/snicksnack`

Utan nyckel. Svar `application/json`:

```json
{
  "name": "Applicerad",
  "version": 1,
  "auth": "api-key",
  "targets": "https://mcp.applicerad.ai/snicksnack/targets",
  "receive": "https://mcp.applicerad.ai/snicksnack/receive",
  "accepts": ["audio", "transcript", "text"],
  "key_url": "https://mcp.applicerad.ai/snicksnack/key",
  "color": "#E27B48",
  "icon": "https://mcp.applicerad.ai/snicksnack/icon.png"
}
```

| Fält | | |
|---|---|---|
| `name` | krävs | Serverns namn som det visas i appen. |
| `version` | krävs | Protokollversion, heltal. Appen avvisar versioner den inte känner. |
| `auth` | krävs | `"api-key"` i version 1. |
| `targets` | krävs | Absolut URL till listan (2). |
| `receive` | krävs | Absolut URL till mottagningen (3); `/<id>` läggs på. |
| `accepts` | valfritt | Vilka delar servern vill ha: `audio`, `transcript`, `text`. Saknas = alla. Appen skickar inte det servern inte vill ha (ljudet är stort). |
| `key_url` | valfritt | Sida där användaren kan hämta en nyckel. Appen kan visa en länk dit. |
| `color` | valfritt | Serverns färg som hex, `"#E27B48"` (# och sex siffror). Appen använder den som accent för mottagarens post (listan, väljaren vid Skicka, markeringen på snacket) och tonar den själv för ljust och mörkt läge. |
| `summarize` | valfritt | Absolut URL till prompterna och sammanfattningen (4, 5). Finns bara när servern har minst en prompt av sorten `summary`. |
| `chat` | valfritt | Absolut URL till chatten (6). Finns bara när servern har minst en prompt av sorten `chat`. |
| `icon` | valfritt | Absolut URL till serverns logga: PNG, kvadratisk, minst 256 px, gärna genomskinlig bakgrund, högst 2 MB. Appen hämtar den en gång och sparar den (igen bara om adressen ändras). Samma regel som adressen: https, http bara på lokala nät. Inte SVG: iOS kan inte rita SVG från nätet. |

Saknas `color` och `icon` visar appen sin vanliga bubbla och namnet. En ogiltig färg eller en logga som inte går
att hämta behandlas som att fältet saknas. Fälten är valfria, så protokollversionen är fortfarande 1.

**Serverns tillägg (inte en del av appens protokoll):** referensmottagaren lägger också till `mcp`, den absoluta adressen
till dess MCP-server för agenter (Streamable HTTP), och `mcp_auth`, hur en agent loggar in där: `["api-key", "oauth"]`.
`api-key` är en agentnyckel som `Authorization: Bearer ssk_agent_…`; `oauth` är OAuth 2.1 enligt MCP:s specifikation
(resursmetadata på `/.well-known/oauth-protected-resource`, servermetadata på `/.well-known/oauth-authorization-server`,
dynamisk registrering och PKCE), som claude.ai:s kopplare använder. `mcp` är fortfarande en sträng, så den som läste
fältet förut läser det likadant. Appen bryr sig inte om fälten; de står här så att andra klienter vet var de hittar
dem. Se README, "Koppla en agent (MCP)".

`.well-known` är en katalog (RFC 8615): varje tjänst har sitt eget namn under den, så `snicksnack` ligger
bredvid t.ex. MCP:s `oauth-protected-resource` utan att krocka.

## 2. Lista: `GET <targets>`

Med nyckel. Svar:

```json
{
  "targets": [
    { "id": "umea-energi", "name": "Umeå Energi", "group": "Kunder" },
    { "id": "inbox", "name": "Inkorg" }
  ]
}
```

`id` är serverns egen identifierare (URL-säker helst; appen procentkodar den). `name` visas för användaren,
`group` är valfri och delar upp listan. Listan är platt i version 1; sök och sidor får komma i en senare version.
Servern bestämmer vad ett mål betyder: kund, projekt, mapp, person. Appen visar bara namnen.

**Nyckeln är avsändarens identitet.** En server kan ha flera avsändare, en nyckel per person, och visa olika
mål för olika nycklar. Appen behöver inte veta vem användaren är hos mottagaren, och transcript.json har inget
avsändarfält: servern vet vem som skickade av nyckeln.

Statuskoder: `401` ogiltig nyckel (appen slutar skicka till servern och ber om en ny nyckel).

## 3. Ta emot: `POST <receive>/<id>`

Med nyckel. Kroppen är `multipart/form-data` med tre delar; servern ska tåla att någon saknas:

| Del | Typ | Innehåll |
|---|---|---|
| `transcript` | `application/json`, filnamn `transcript.json` | Snacket som data, se nedan. Skickas alltid. |
| `text` | `text/markdown`, filnamn `<rubrik>.md` | Samma som appens markdown-export: rubrik, datum, sammanfattning, transkript per talare. |
| `audio` | `audio/mp4` (Apple Lossless i .m4a) eller `audio/wav`, filnamn `<id>.m4a` | Ljudet. Saknas om det är borttaget eller servern inte tar emot ljud. |

Huvuden: `Authorization: Bearer <nyckel>`, `Idempotency-Key: <snackets id>`.

**Samma snack kan skickas igen** (användaren har döpt, taggat eller kört om det). Servern ska då uppdatera,
inte dubblera: `transcript.id` är detsamma, liksom `Idempotency-Key`.

Svar `2xx` med `application/json`:

```json
{ "id": "kunder/umea-energi/inkorg/2026-10-10-styrgrupp", "url": "https://…" }
```

`url` är valfri: en länk som appen visar som "Skickat till Umeå Energi, öppna".

Statuskoder: `401` ogiltig nyckel, `404` målet finns inte längre (appen uppdaterar listan), `413` för stort
(appen ger upp och säger det), `5xx` och nätfel: appen försöker igen senare.

### transcript.json

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
  "note": "Användarens egen anteckning, eller null",
  "quick_note": false,
  "speakers": { "0": "Anna", "1": "Talare 2" },
  "speakers_hidden": false,
  "text": "Hela texten som ett stycke …",
  "words": [
    { "text": "Vi", "start": 0.32, "end": 0.48, "speaker": 0 },
    { "text": "börjar.", "start": 0.51, "end": 0.90, "speaker": 0 }
  ],
  "summaries": [
    {
      "kind": "decisions",
      "created_at": "2026-10-10T10:02:40+02:00",
      "items": [
        { "section": "Beslut", "text": "Taxan höjs med 3 % från januari.", "speaker": 1, "at": 412.5 }
      ]
    }
  ],
  "parts": [
    { "start": 0, "duration": 600.0, "recorded_at": "2026-10-10T09:30:12+02:00", "title": "Första delen" }
  ],
  "app": { "name": "Snicksnack", "version": "2.1 (9)", "model": "pianissimo-sv-coreml-int8-v1" }
}
```

| Fält | |
|---|---|
| `id` | Snackets id i appen. Stabilt: samma vid omsändning. |
| `recorded_at` | ISO 8601 med tidszon. |
| `duration` | Sekunder. |
| `language` | ISO 639-1 (`sv`, `en`, `da`, `fi`, `de` …). |
| `speakers` | Talar-id → namn. Id utan namn får "Talare N" (på appens språk). Tomt när talarna inte är igenkända. |
| `speakers_hidden` | Användaren har dolt talarna i visningen; `words[].speaker` finns ändå. |
| `words` | Varje ord med tider i sekunder från start och talare (eller `null`). Skiljetecken sitter kvar i ordet. Tom lista för gamla snack utan ordtider; `text` finns alltid. |
| `summaries` | Appens sammanfattningar, äldst först. `kind`: `short`, `decisions`, `minutes`, `quotes`. `section` är avsnittets rubrik som appen visar den ("Sammanfattning", "Beslut", "Att göra", "Frågor", "Citat"). `at` är sekund i inspelningen när punkten har en källa. |
| `parts` | Bara för sammanslagna snack: delarna i den gemensamma tidslinjen. Annars tom. |
| `quick_note` | En snabbanteckning. |

## 4. Prompter: `GET <summarize>`

Med nyckel. Servern låter appen använda extern AI genom fasta prompter. Prompter tilldelas avsändare precis som mål;
listan innehåller bara de prompter nyckeln får använda. Svar:

```json
{
  "prompts": [
    { "id": "coachrapport", "name": "Coachrapport", "description": "Vad som gick bra…", "kind": "summary", "live": false }
  ]
}
```

`kind` är `"summary"` (används med 5) eller `"chat"` (ett snabbval i chatten, 6). `live` betyder att prompten får
användas under pågående inspelning.

Statuskoder: `401` ogiltig nyckel.

## 5. Sammanfatta: `POST <summarize>/<prompt-id>`

Med nyckel. Kroppen är `application/json`: samma transcript.json som i mottagningen (3), med fälten `text`, `words`,
`speakers`, `note`, `title`, `duration`, `language`, `tags` …

Svar `200`:

```json
{
  "summary": {
    "kind": "custom",
    "name": "Coachrapport",
    "prompt": "coachrapport",
    "created_at": "2026-10-17T09:12:00+02:00",
    "items": [{ "section": "Rubrik", "text": "…", "speaker": 0, "at": 12.3 }]
  },
  "markdown": "…"
}
```

`speaker` och `at` är `null` när de saknas. Servern begär ett strukturerat svar av modellen (JSON med avsnitt och
punkter) och validerar det; följer det inte formen görs anropet om en gång, annars `502` med `{"error": …}`.
Anropet är synkront och kan ta upp till ett par minuter.

Statuskoder: `401` ogiltig nyckel, `404` okänd prompt eller en prompt avsändaren inte har, `413` för stor kropp,
`502` modellen svarade fel eller inte i formen.

## 6. Chatta: `POST <chat>`

Med nyckel. Kroppen är `application/json`:

```json
{
  "prompt": "sammanfatta-hittills",
  "messages": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "transcript": { "…": "transcript.json" },
  "live": true
}
```

- `prompt` är ett prompt-id eller `null`. Är det satt lägger servern själv till promptens användartext som sista
  användarmeddelande (appen visar promptens namn som bubbla). Annars är sista meddelandet i `messages` frågan.
- Hela transkriptet (texten med talarprefix när talaren byts) och anteckningen (`note`) läggs i systemprompten,
  tillsammans med promptens eller mottagarens systemtext.
- Vid `live: true` säger systemprompten att mötet pågår och att texten är det som sagts hittills.

Svar `text/event-stream` med rader `data: {"content": "…"}` under strömningen, valfritt `data: {"status": "…"}`, och
sist `data: {"done": true}`. Fel innan strömmen börjar: vanlig `4xx`/`5xx` med JSON. Fel mitt i: `data: {"error": "…"}`
och strömmen stängs.

Chatten är statelös: servern sparar inget av den (men får räkna anrop och tokens).

Statuskoder före strömmen: `401` ogiltig nyckel, `404` okänd prompt eller prompt avsändaren inte har, `413` för
stor kropp, `5xx` fel hos servern eller modellen.

## Appens sida

- **Skicka är ett val per snack**, aldrig i smyg. Per mottagare kan användaren välja ett standardmål och slå på
  att nya snack skickas dit av sig själva när de är klara (efter omkörningen och komprimeringen). Snabbanteckningar
  skickas aldrig automatiskt.
- **Kön** ligger kvar tills telefonen är online. Misslyckade sändningar görs om med växande väntetid (1, 2, 4 … 60 min)
  och när appen blir aktiv eller nätet kommer tillbaka.
- **Nyckeln** ligger i nyckelringen (tillgänglig efter första upplåsningen, så kön går i bakgrunden). Den lämnar
  aldrig telefonen annat än till sin egen server.
- **Adressen** måste vara https, utom till lokala nät (`NSAllowsLocalNetworking`), så en hemmaserver går att nå med http.
- **QR-koden** innehåller `snicksnack://receiver?url=https://<domän>&key=<nyckel>`. Samma sak går att skriva in för hand.

### Vad motorn exponerar för vyerna (`Regi.shared.mottagare`, `MottagarStore`)

| | |
|---|---|
| `mottagare: [Mottagare]` | De kopplade servrarna: `namn`, `url`, `mål`, `standardmål`, `automatik`, `nyckelOgiltig`, `färg`, `ikonURL`, `ikonFil`. |
| `Mottagare.färg: String?` | Serverns hexfärg, `"#E27B48"` (validerad, versaler), eller nil. Vyn tonar den för ljust och mörkt läge. |
| `Mottagare.ikonFil: URL?` | Loggan som lokal PNG (Application Support/mottagare/<id>.png) när den är hämtad, annars nil: visa bubblan och namnet. `ikonURL` är serverns adress. Hämtas i bakgrunden vid `läggTill` och `uppdateraMål`; posten i `mottagare` ändras när filen är klar. |
| `läggTill(url:nyckel:) async throws -> Mottagare` | Hämtar well-known och målen, sparar nyckeln. Fel: `MottagarFel` med text för användaren. |
| `uppdateraMål(_:) async throws` | Hämtar listan igen, och well-known för namn, färg och logga. |
| `taBort(_:)`, `sätt(standardmål:för:)`, `sätt(automatik:för:)`, `byt(nyckel:för:) async throws` | |
| `skicka(_ snack: Snack, till mottagare: Mottagare, mål: Mål)` | Lägger i kön och börjar skicka. |
| `sändningar(för snack: Snack) -> [Sändning]` | Status per snack: `.kö`, `.skickar`, `.skickad(url)`, `.fel(text)`, `.väntar(nästaFörsök)`, med `målnamn` och `mottagarnamn`. |
| `skickaIgen(_ sändning:)` | Nytt försök direkt. |
| `MottagarStore.tolka(_ text: String) -> Koppling?` | QR-koden eller en inklistrad adress: `url` och `nyckel` (nil när bara en domän angavs, då frågar vyn efter nyckeln). |
| `MottagarFel` | Feltexter för användaren: ingen mottagare på adressen, fel version, ogiltig nyckel, serverns svar. |

## Testa

`tools/mottagare_test.py <katalog> [--port 8765] [--key hemlig]` är en liten mottagare på Mac: well-known, två mål
färg, logga (`/icon.png`) och mottagning som sparar filerna i katalogen. På telefonen: `--mottagartest http://<mac-ip>:8765 hemlig`
kopplar servern, listar målen och skickar det senaste klara snacket.

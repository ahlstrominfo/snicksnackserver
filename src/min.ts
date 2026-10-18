// Avsändarens personliga sida /min/<token>: agentnycklar för MCP, inloggade OAuth-klienter och hur man kopplar en agent.
// Länken är inloggningen; den syns för ägaren under Avsändare och kan bytas där.

import { agentnycklar, avsändareFrånSidtoken, mcpKommandon, skapaAgentnyckel, spärraAgentnyckel } from "./agenter";
import { hämtaInställningar } from "./db";
import { förbrukning, kvoterFör, kvottext } from "./kvoter";
import { klientIp, tillåt, väntetid } from "./ratelimit";
import { revisionslogg } from "./revision";
import { inloggningar, återkallaInloggning, type Inloggning } from "./oauth";
import { html, htmlSvar, raw, type Raw } from "./html";
import { FAVICON, fältrad, logga, rubrik, SKRIPT, STIL, tomt } from "./utseende";

const HUVUDEN = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

/** En sida utan adminens flikar (personliga sidan och OAuth-inloggningen). */
export function enkelSida(mottagare: string, titel: string, innehåll: Raw): Raw {
  return html`<html lang="sv">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex" />
      <meta name="referrer" content="no-referrer" />
      <meta name="theme-color" content="#FBF5EC" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#1A1411" media="(prefers-color-scheme: dark)" />
      <link rel="icon" type="image/svg+xml" href="${FAVICON}" />
      <title>${titel} · ${mottagare}</title>
      <style>${raw(STIL)}</style>
    </head>
    <body>
      <header class="topp"><div class="inre"><div class="topprad"><span class="marke">${logga()}<span>${mottagare}</span></span></div></div></header>
      <main>${innehåll}</main>
      <script>${raw(SKRIPT)}</script>
    </body>
  </html>`;
}

/** 429 som sida, med Retry-After. */
export function förMångaSida(mottagare: string, text: string, sekunder: number, huvuden: Record<string, string> = {}): Response {
  return htmlSvar(
    enkelSida(mottagare, "Vänta lite", html`<div class="lugn">${rubrik("Vänta lite")}<p class="fel">${text}</p></div>`),
    429,
    { "Retry-After": String(sekunder), ...huvuden },
  );
}

const tid = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" }) : "aldrig";

/** Blocket med kommandona: med den nya nyckeln om den just skapats, annars en platshållare. */
export function instruktioner(origin: string, nyckel: string | null, omfång: string): Raw {
  const k = mcpKommandon(origin, nyckel ?? "<din agentnyckel>");
  return html`<div class="kort">
    <h3 style="margin-top:0">Claude Code</h3>
    <pre class="text">${k.claudeCode}</pre>
    <div class="knappar" style="margin-top:8px"><button type="button" class="diskret liten" data-kopiera="${k.claudeCode}">Kopiera kommandot</button></div>
    <h3>Cursor och andra MCP-klienter</h3>
    <pre class="text">${k.json}</pre>
    <div class="knappar" style="margin-top:8px"><button type="button" class="diskret liten" data-kopiera="${k.json}">Kopiera JSON</button></div>
    <p class="tips" style="margin-top:14px">Adressen är <code>${k.adress}</code> (Streamable HTTP). ${omfång}</p>
    <h3>claude.ai (Claude-appen)</h3>
    <p>Inställningar → Kopplare → Lägg till egen kopplare. Klistra in adressen <code>${k.adress}</code> och lämna
      client id och secret tomma. Claude öppnar en inloggning här: logga in med länken till Din sida (eller som ägare
      med adminlösenordet). Ingen agentnyckel behövs.</p>
    <div class="knappar" style="margin-top:8px"><button type="button" class="diskret liten" data-kopiera="${k.adress}">Kopiera adressen</button></div>
  </div>`;
}

/** Listan med inloggade OAuth-klienter; vem visas för ägaren (avsändarens namn). */
export function inloggningslista(lista: Inloggning[], åtgärd: (id: string) => string, vem: (owner: string) => string | null = () => null): Raw {
  if (!lista.length) return html`<p class="dim" style="margin:0 6px 14px">Inga klienter inloggade.</p>`;
  return html`<div class="lista">${lista.map((g) => {
    const v = vem(g.owner);
    return html`<div class="nyckelrad">
      <div class="radtext">
        <div class="radtopp"><span class="namn">${g.client_name}</span></div>
        <div class="meta">${v ? html`${v} · ` : ""}inloggad ${tid(g.created_at)} · senast använd ${tid(g.last_used_at)}</div>
      </div>
      <form method="post" action="${åtgärd(g.id)}" data-bekrafta="Återkalla inloggningen? Klienten slutar fungera direkt.">
        <button class="farlig liten">Återkalla</button></form>
    </div>`;
  })}</div>`;
}

type Avsändarrad = NonNullable<Awaited<ReturnType<typeof avsändareFrånSidtoken>>>;

export async function minSida(req: Request, env: Env, delar: string[]): Promise<Response> {
  const url = new URL(req.url);
  const [token, ...rest] = delar;
  const s = await hämtaInställningar(env.DB);
  const avs = token ? await avsändareFrånSidtoken(env.DB, token) : null;
  if (!avs || !avs.key_hash) {
    if (!(await tillåt(env, "gissning", klientIp(req)))) {
      return förMångaSida(s.name, "För många försök med en länk som inte fungerar. Vänta en minut.", väntetid("gissning"), HUVUDEN);
    }
    return htmlSvar(
      enkelSida(s.name, "Finns inte", html`<div class="lugn">${rubrik("Länken fungerar inte")}${tomt("Be den som driver mottagaren om en ny länk.")}</div>`),
      404,
      HUVUDEN,
    );
  }
  const bas = `/min/${encodeURIComponent(token)}`;

  if (req.method === "POST") {
    const ursprung = req.headers.get("Origin");
    if (ursprung && ursprung !== url.origin) return htmlSvar(enkelSida(s.name, "Nekad", rubrik("Nekad")), 403, HUVUDEN);
    if (rest.length === 1 && rest[0] === "agenter") {
      const f = await req.formData().catch(() => new FormData());
      const namn = String(f.get("name") ?? "").trim() || "Agent";
      const nyckel = await skapaAgentnyckel(env.DB, avs.id, namn);
      await revisionslogg(env, req, "agentnyckel.skapad", `${namn} för ${avs.name}`, `avsändare:${avs.id}`);
      return visa(env, s.name, avs, url, bas, { namn, nyckel });
    }
    if (rest.length === 3 && rest[0] === "klienter" && rest[2] === "aterkalla") {
      const ok = await återkallaInloggning(env.DB, rest[1], avs.id);
      if (ok) await revisionslogg(env, req, "oauth.aterkallad", `Inloggning ${rest[1]} för ${avs.name}`, `avsändare:${avs.id}`);
      return new Response(null, {
        status: 303,
        headers: { Location: `${bas}?meddelande=${encodeURIComponent(ok ? "Inloggningen är återkallad." : "Inloggningen fanns inte.")}`, ...HUVUDEN },
      });
    }
    if (rest.length === 3 && rest[0] === "agenter" && rest[2] === "sparra") {
      const ok = await spärraAgentnyckel(env.DB, rest[1], avs.id);
      if (ok) await revisionslogg(env, req, "agentnyckel.sparrad", `Nyckel ${rest[1]} för ${avs.name}`, `avsändare:${avs.id}`);
      return new Response(null, {
        status: 303,
        headers: { Location: `${bas}?meddelande=${encodeURIComponent(ok ? "Nyckeln är spärrad." : "Nyckeln fanns inte.")}`, ...HUVUDEN },
      });
    }
    return htmlSvar(enkelSida(s.name, "Finns inte", rubrik("Finns inte")), 404, HUVUDEN);
  }
  if (rest.length) return htmlSvar(enkelSida(s.name, "Finns inte", rubrik("Finns inte")), 404, HUVUDEN);
  return visa(env, s.name, avs, url, bas, null);
}

async function visa(
  env: Env,
  mottagare: string,
  avs: Avsändarrad,
  url: URL,
  bas: string,
  ny: { namn: string; nyckel: string } | null,
): Promise<Response> {
  const [nycklar, antal, klienter, kvoter, förbrukat] = await Promise.all([
    agentnycklar(env.DB, avs.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM snacks WHERE sender_id = ?").bind(avs.id).first<{ n: number }>(),
    inloggningar(env.DB, avs.id),
    hämtaInställningar(env.DB).then((s) => kvoterFör(env.DB, avs.id, s)),
    förbrukning(env.DB, avs.id),
  ]);
  const n = antal?.n ?? 0;
  const besked = url.searchParams.get("meddelande");
  const aktiva = nycklar.filter((k) => !k.revoked_at);
  return htmlSvar(
    enkelSida(
      mottagare,
      avs.name,
      html`${rubrik(avs.name, n === 0 ? `Inga snack skickade till ${mottagare} än.` : n === 1 ? `Ett snack skickat till ${mottagare}.` : `${n} snack skickade till ${mottagare}.`)}
        <p class="fel" style="font-weight:600">Den här länken är din inloggning, dela den inte.</p>
        <p class="dim" style="margin:0 6px 14px">Förbrukning: ${kvottext(kvoter, förbrukat)}.</p>
        ${besked && !ny ? html`<p class="meddelande">${besked}</p>` : ""}
        ${ny
          ? html`<p class="meddelande">Nyckeln för ${ny.namn} visas bara nu. Kopiera kommandot nedan.</p>
              <div class="kort"><dl class="fakta"><div><dt>Agentnyckel</dt><dd><code>${ny.nyckel}</code></dd></div></dl>
              <div class="knappar" style="margin-top:8px"><button type="button" class="diskret liten" data-kopiera="${ny.nyckel}">Kopiera nyckeln</button></div></div>`
          : ""}
        <h2>Koppla en agent</h2>
        <p class="dim" style="margin:0 6px 12px">En AI-agent (Claude Code, Cursor …) kan läsa och söka i dina snack via MCP.
          Skapa en nyckel per agent, så kan du spärra en i taget.</p>
        ${instruktioner(url.origin, ny?.nyckel ?? null, "Nyckeln ser bara dina egna snack.")}
        <h2>Dina agentnycklar</h2>
        ${nycklar.length
          ? html`<div class="lista">${nycklar.map(
              (k) => html`<div class="nyckelrad">
                <div class="radtext">
                  <div class="radtopp"><span class="namn">${k.name}</span></div>
                  <div class="meta">${k.revoked_at ? `Spärrad ${tid(k.revoked_at)}` : html`…${k.key_hint} · senast använd ${tid(k.last_used_at)}`}
                    · skapad ${tid(k.created_at)}</div>
                </div>
                ${k.revoked_at
                  ? ""
                  : html`<form method="post" action="${bas}/agenter/${encodeURIComponent(k.id)}/sparra"
                      data-bekrafta="Spärra nyckeln? Agenten slutar fungera direkt."><button class="farlig liten">Spärra</button></form>`}
              </div>`,
            )}</div>`
          : tomt("Inga agentnycklar än.")}
        <details class="lista post ny"${raw(!aktiva.length && !ny ? " open" : "")}>
          <summary><span class="plus">+</span><span class="radtext">Ny agentnyckel</span></summary>
          <div class="postinnehall">
            <form method="post" action="${bas}/agenter">
              ${fältrad("Namn", html`<input type="text" name="name" required maxlength="80" placeholder="Claude Code på jobbdatorn" />`)}
              <div class="knappar"><button>Skapa och visa nyckel</button></div>
            </form>
          </div>
        </details>
        <h2>Inloggade klienter</h2>
        <p class="dim" style="margin:0 6px 12px">Klienter som loggat in med din länk, till exempel claude.ai.</p>
        ${inloggningslista(klienter, (id) => `${bas}/klienter/${encodeURIComponent(id)}/aterkalla`)}`,
    ),
    200,
    HUVUDEN,
  );
}

// Avsändarens personliga sida /min/<token>: agentnycklar för MCP och hur man kopplar en agent.
// Länken är inloggningen; den syns för ägaren under Avsändare och kan bytas där.

import { agentnycklar, mcpKommandon, skapaAgentnyckel, spärraAgentnyckel } from "./agenter";
import { hämtaInställningar } from "./db";
import { html, htmlSvar, raw, type Raw } from "./html";
import { FAVICON, fältrad, logga, rubrik, SKRIPT, STIL, tomt } from "./utseende";

const HUVUDEN = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

function sida(mottagare: string, titel: string, innehåll: Raw): Raw {
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
    <p class="tips" style="margin-top:14px">Adressen är <code>${k.adress}</code> (Streamable HTTP). ${omfång}
      claude.ai kan inte kopplas än: den kräver OAuth, som servern inte har.</p>
  </div>`;
}

interface Avsändarrad {
  id: string;
  name: string;
  key_hash: string | null;
}

export async function minSida(req: Request, env: Env, delar: string[]): Promise<Response> {
  const url = new URL(req.url);
  const [token, ...rest] = delar;
  const s = await hämtaInställningar(env.DB);
  const avs = token
    ? await env.DB.prepare("SELECT id, name, key_hash FROM senders WHERE page_token = ?").bind(token).first<Avsändarrad>()
    : null;
  if (!avs || !avs.key_hash) {
    return htmlSvar(
      sida(s.name, "Finns inte", html`<div class="lugn">${rubrik("Länken fungerar inte")}${tomt("Be den som driver mottagaren om en ny länk.")}</div>`),
      404,
      HUVUDEN,
    );
  }
  const bas = `/min/${encodeURIComponent(token)}`;

  if (req.method === "POST") {
    const ursprung = req.headers.get("Origin");
    if (ursprung && ursprung !== url.origin) return htmlSvar(sida(s.name, "Nekad", rubrik("Nekad")), 403, HUVUDEN);
    if (rest.length === 1 && rest[0] === "agenter") {
      const f = await req.formData().catch(() => new FormData());
      const namn = String(f.get("name") ?? "").trim() || "Agent";
      const nyckel = await skapaAgentnyckel(env.DB, avs.id, namn);
      return visa(env, s.name, avs, url, bas, { namn, nyckel });
    }
    if (rest.length === 3 && rest[0] === "agenter" && rest[2] === "sparra") {
      const ok = await spärraAgentnyckel(env.DB, rest[1], avs.id);
      return new Response(null, {
        status: 303,
        headers: { Location: `${bas}?meddelande=${encodeURIComponent(ok ? "Nyckeln är spärrad." : "Nyckeln fanns inte.")}`, ...HUVUDEN },
      });
    }
    return htmlSvar(sida(s.name, "Finns inte", rubrik("Finns inte")), 404, HUVUDEN);
  }
  if (rest.length) return htmlSvar(sida(s.name, "Finns inte", rubrik("Finns inte")), 404, HUVUDEN);
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
  const [nycklar, antal] = await Promise.all([
    agentnycklar(env.DB, avs.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM snacks WHERE sender_id = ?").bind(avs.id).first<{ n: number }>(),
  ]);
  const n = antal?.n ?? 0;
  const besked = url.searchParams.get("meddelande");
  const aktiva = nycklar.filter((k) => !k.revoked_at);
  return htmlSvar(
    sida(
      mottagare,
      avs.name,
      html`${rubrik(avs.name, n === 0 ? `Inga snack skickade till ${mottagare} än.` : n === 1 ? `Ett snack skickat till ${mottagare}.` : `${n} snack skickade till ${mottagare}.`)}
        <p class="fel" style="font-weight:600">Den här länken är din inloggning, dela den inte.</p>
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
                      onsubmit="return confirm('Spärra nyckeln? Agenten slutar fungera direkt.')"><button class="farlig liten">Spärra</button></form>`}
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
        </details>`,
    ),
    200,
    HUVUDEN,
  );
}

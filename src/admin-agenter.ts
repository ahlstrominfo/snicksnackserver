// Admin: agentnycklar för MCP (/admin/agenter). Ägarens nycklar ser allt; avsändarnas skapas på deras egna sidor.

import { EjFunnen, fält, formulär, medMeddelande, meddelande, sida, tidpunkt } from "./admin";
import { agentnycklar, skapaAgentnyckel, spärraAgentnyckel } from "./agenter";
import type { Inställningar } from "./db";
import { html, htmlSvar, raw } from "./html";
import { instruktioner } from "./min";
import { byggOmIndex } from "./sok";
import { fältrad, rubrik, tomt } from "./utseende";

export async function adminAgenter(req: Request, env: Env, s: Inställningar, delar: string[], url: URL): Promise<Response | null> {
  const post = req.method === "POST";
  if (delar.length === 1) return post ? skapa(req, env, s, url) : visa(env, s, url, null);
  if (delar.length === 3 && delar[2] === "sparra" && post) {
    if (!(await spärraAgentnyckel(env.DB, delar[1]))) throw new EjFunnen();
    return medMeddelande("/admin/agenter", "Nyckeln är spärrad.");
  }
  if (delar.length === 2 && delar[1] === "sokindex" && post) {
    const r = await byggOmIndex(env);
    return medMeddelande("/admin/agenter", `Sökindexet är ombyggt: ${r.indexerade} av ${r.snack} snack.`);
  }
  return null;
}

async function skapa(req: Request, env: Env, s: Inställningar, url: URL): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name") || "Agent";
  const nyckel = await skapaAgentnyckel(env.DB, "owner", namn);
  return visa(env, s, url, { namn, nyckel });
}

const tid = (iso: string | null) => (iso ? tidpunkt(iso) : "aldrig");

async function visa(env: Env, s: Inställningar, url: URL, ny: { namn: string; nyckel: string } | null): Promise<Response> {
  const [nycklar, { results: avsändare }, fts] = await Promise.all([
    agentnycklar(env.DB),
    env.DB.prepare("SELECT id, name FROM senders").all<{ id: string; name: string }>(),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM snacks_fts) AS i, (SELECT COUNT(*) FROM snacks) AS s").first<{ i: number; s: number }>(),
  ]);
  const namn = new Map(avsändare.map((a) => [a.id, a.name]));
  const ägarens = nycklar.filter((k) => k.owner === "owner");
  const deras = nycklar.filter((k) => k.owner !== "owner");
  const rad = (k: (typeof nycklar)[number], vem: string | null) => html`<div class="nyckelrad">
    <div class="radtext">
      <div class="radtopp"><span class="namn">${k.name}</span></div>
      <div class="meta">${vem ? html`${vem} · ` : ""}${k.revoked_at ? `Spärrad ${tid(k.revoked_at)}` : html`…${k.key_hint} · senast använd ${tid(k.last_used_at)}`}
        · skapad ${tid(k.created_at)}</div>
    </div>
    ${k.revoked_at
      ? ""
      : html`<form method="post" action="/admin/agenter/${encodeURIComponent(k.id)}/sparra"
          onsubmit="return confirm('Spärra nyckeln? Agenten slutar fungera direkt.')"><button class="farlig liten">Spärra</button></form>`}
  </div>`;

  return htmlSvar(
    sida(
      s,
      "Agenter",
      html`${rubrik("Agenter", "AI-agenter (Claude Code, Cursor …) kan läsa och söka i snacken via MCP med en agentnyckel.")}
        ${meddelande(url)}
        ${ny
          ? html`<p class="meddelande">Nyckeln för ${ny.namn} visas bara nu. Den ser alla snack.</p>
              <div class="kort"><dl class="fakta"><div><dt>Agentnyckel</dt><dd><code>${ny.nyckel}</code></dd></div></dl>
              <div class="knappar" style="margin-top:8px"><button type="button" class="diskret liten" data-kopiera="${ny.nyckel}">Kopiera nyckeln</button></div></div>`
          : ""}
        <h2>Koppla en agent</h2>
        ${instruktioner(url.origin, ny?.nyckel ?? null, "Dina nycklar ser alla snack; avsändarnas nycklar bara deras egna.")}
        <h2>Dina agentnycklar</h2>
        ${ägarens.length ? html`<div class="lista">${ägarens.map((k) => rad(k, null))}</div>` : tomt("Inga nycklar än.")}
        <details class="lista post ny"${raw(!ägarens.length && !ny ? " open" : "")}>
          <summary><span class="plus">+</span><span class="radtext">Ny agentnyckel</span></summary>
          <div class="postinnehall">
            <form method="post" action="/admin/agenter">
              ${fältrad("Namn", html`<input type="text" name="name" required maxlength="80" placeholder="Claude Code på jobbdatorn" />`)}
              <div class="knappar"><button>Skapa och visa nyckel</button></div>
            </form>
          </div>
        </details>
        <h2>Avsändarnas agentnycklar</h2>
        ${deras.length
          ? html`<div class="lista">${deras.map((k) => rad(k, namn.get(k.owner) ?? k.owner))}</div>`
          : html`<p class="dim" style="margin:0 6px">Avsändarna skapar sina egna på sin personliga sida (länken finns under Avsändare).</p>`}
        <h2>Sökindex</h2>
        <div class="kort">
          <p>${fts?.i ?? 0} av ${fts?.s ?? 0} snack finns i sökindexet. Nya snack läggs in när de kommer; bygg om för dem som kom före sökningen.</p>
          <form method="post" action="/admin/agenter/sokindex"><button class="diskret">Bygg om sökindexet</button></form>
        </div>`,
      "/admin/agenter",
    ),
  );
}

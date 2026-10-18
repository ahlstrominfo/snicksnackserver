// Admin för extern AI: leverantörer (/admin/leverantorer) och prompter (/admin/prompter).

import { EjFunnen, felruta, fält, flera, formulär, medMeddelande, meddelande, sida } from "./admin";
import type { Prompt } from "./ai/anrop";
import { MODELLFÖRSLAG, STANDARDMODELL, TYPER, type Leverantör, type Typ } from "./ai/leverantorer";
import { MÅL_ID, nu, slug, type Inställningar } from "./db";
import { html, htmlSvar, raw, type Raw } from "./html";
import { fältrad, rubrik, tomt, valgrupp, växel } from "./utseende";
import { kryptera, maskera } from "./krypto";
import { revisionslogg } from "./revision";

const TYPNAMN: Record<Typ, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI-kompatibel (OpenAI, Mistral, Azure, Ollama …)",
  test: "Test (ingen AI, ingen nyckel)",
};

const KORTNAMN: Record<Typ, string> = { anthropic: "Anthropic", openai: "OpenAI-kompatibel", test: "Test" };

/** Hanterar /admin/leverantorer… och /admin/prompter…; null = finns inte. */
export async function adminAi(req: Request, env: Env, s: Inställningar, delar: string[], url: URL): Promise<Response | null> {
  const post = req.method === "POST";
  if (delar[0] === "leverantorer") {
    if (delar.length === 1) return post ? skapaLeverantör(req, env, s, url) : leverantörSida(env, s, url);
    if (delar.length === 2 && post) return ändraLeverantör(req, env, s, url, delar[1]);
    if (delar.length === 3 && delar[2] === "ta-bort" && post) return taBortLeverantör(req, env, s, delar[1]);
  }
  if (delar[0] === "prompter") {
    if (delar.length === 1) return post ? skapaPrompt(req, env, s, url) : promptSida(env, s, url);
    if (delar.length === 2 && post) return ändraPrompt(req, env, s, url, delar[1]);
    if (delar.length === 3 && delar[2] === "ta-bort" && post) return taBortPrompt(req, env, delar[1]);
  }
  return null;
}

// ---------- Hjälp för avsändarsidan ----------

export async function allaPrompter(db: D1Database): Promise<Prompt[]> {
  const { results } = await db.prepare("SELECT * FROM prompts ORDER BY kind DESC, created_at, name").all<Prompt>();
  return results;
}

const sortnamn = (p: { kind: string; live: number }) => (p.kind === "chat" ? "chatt" : "sammanfattning") + (p.live ? ", live" : "");

export function promptVal(prompter: Prompt[], valda: string[]): Raw {
  if (!prompter.length) return html`<span class="tips">Inga prompter än. <a href="/admin/prompter">Skapa en prompt</a>.</span>`;
  return html`${prompter.map(
    (p) =>
      html`<label class="val"><input type="checkbox" name="prompts" value="${p.id}"${raw(valda.includes(p.id) ? " checked" : "")} />
        ${p.name} <span class="dim">${sortnamn(p)}</span></label>`,
  )}`;
}

export async function sättPrompterFörAvsändare(db: D1Database, avsändare: string, prompter: string[]): Promise<void> {
  const giltiga = new Set((await allaPrompter(db)).map((p) => p.id));
  await db.batch([
    db.prepare("DELETE FROM sender_prompts WHERE sender_id = ?").bind(avsändare),
    ...[...new Set(prompter)]
      .filter((p) => giltiga.has(p))
      .map((p) => db.prepare("INSERT INTO sender_prompts (sender_id, prompt_id) VALUES (?, ?)").bind(avsändare, p)),
  ]);
}

function modellista(): Raw {
  const alla = [...new Set(Object.values(MODELLFÖRSLAG).flat())];
  return html`<datalist id="modeller">${alla.map((m) => html`<option value="${m}"></option>`)}</datalist>`;
}

// ---------- Leverantörer ----------

async function leverantörSida(env: Env, s: Inställningar, url: URL, fel: string | null = null, status = 200): Promise<Response> {
  const [{ results: leverantörer }, { results: användning }, { results: antal }] = await Promise.all([
    env.DB.prepare("SELECT * FROM providers ORDER BY created_at, name").all<Leverantör>(),
    env.DB.prepare(
      `SELECT provider_id, model, SUM(requests) AS anrop, SUM(input_tokens) AS tin, SUM(output_tokens) AS tut
       FROM usage WHERE day >= ? GROUP BY provider_id, model ORDER BY provider_id, model`,
    )
      .bind(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
      .all<{ provider_id: string; model: string; anrop: number; tin: number; tut: number }>(),
    env.DB.prepare("SELECT provider_id, COUNT(*) AS n FROM prompts GROUP BY provider_id").all<{ provider_id: string; n: number }>(),
  ]);
  const promptantal = new Map(antal.map((r) => [r.provider_id, r.n]));
  const typval = (vald: Typ) =>
    TYPER.map((t) => html`<option value="${t}"${raw(t === vald ? " selected" : "")}>${TYPNAMN[t]}</option>`);
  const utanSecret = env.KEY_SECRET
    ? ""
    : html`<p class="fel">KEY_SECRET saknas, så API-nycklar går inte att spara. Kör <code>npx wrangler secret put KEY_SECRET</code>.</p>`;
  const tal = (n: number) => n.toLocaleString("sv-SE");

  return htmlSvar(
    sida(
      s,
      "Leverantörer",
      html`${rubrik("Leverantörer", "Var AI-anropen går. Nycklarna sparas krypterade och visas aldrig igen.")}
        ${meddelande(url)} ${felruta(fel)} ${utanSecret} ${modellista()}
        ${leverantörer.length
          ? html`<div class="lista">
              ${leverantörer.map(
                (l, i) => html`<details class="post">
                  <summary>
                    <div class="radtext">
                      <div class="namn">${l.name}</div>
                      <div class="meta">${KORTNAMN[l.type]} · ${promptantal.get(l.id) ?? 0} prompter${l.type !== "test" ? ` · nyckel ${l.key_hint ?? "saknas"}` : ""}</div>
                    </div>
                    <span class="chev">›</span>
                  </summary>
                  <div class="postinnehall">
                    <form id="ta-bort-lev-${i}" method="post" action="/admin/leverantorer/${encodeURIComponent(l.id)}/ta-bort"
                      data-bekrafta="Ta bort leverantören?"></form>
                    <form method="post" action="/admin/leverantorer/${encodeURIComponent(l.id)}">
                      ${fältrad("Namn", html`<input type="text" name="name" value="${l.name}" required />`)}
                      ${fältrad("Typ", html`<select name="type">${typval(l.type)}</select>`)}
                      ${fältrad(
                        "Bas-URL",
                        html`<input type="text" name="base_url" value="${l.base_url ?? ""}" placeholder="https://api.openai.com/v1" />`,
                        "Bara för OpenAI-kompatibla.",
                      )}
                      ${fältrad("Standardmodell", html`<input type="text" name="model" value="${l.model ?? ""}" list="modeller" placeholder="${STANDARDMODELL[l.type]}" />`)}
                      ${l.type !== "test"
                        ? html`${fältrad(
                            "API-nyckel",
                            html`<input type="password" name="api_key" autocomplete="off" placeholder="${l.key_hint ? `Oförändrad (${l.key_hint})` : "Ingen sparad"}" />`,
                            l.key_hint ? "Lämna tomt för att behålla den sparade." : null,
                          )}
                          ${l.key_hint ? växel("remove_key", "Ta bort nyckeln", false) : ""}`
                        : ""}
                      <p class="tips">Id <code>${l.id}</code></p>
                      <div class="knappar">
                        <button>Spara</button>
                        <span class="hoger"><button class="farlig" form="ta-bort-lev-${i}">Ta bort</button></span>
                      </div>
                    </form>
                  </div>
                </details>`,
              )}
            </div>`
          : tomt("Ingen leverantör än. Lägg till en så kan prompterna nå en AI.")}
        <details class="lista post ny"${raw(!leverantörer.length || fel ? " open" : "")}>
          <summary><span class="plus">+</span><span class="radtext">Ny leverantör</span></summary>
          <div class="postinnehall">
            <form method="post" action="/admin/leverantorer">
              ${fältrad("Namn", html`<input type="text" name="name" required placeholder="Claude" />`)}
              ${fältrad("Id", html`<input type="text" name="id" placeholder="Av namnet, t.ex. claude" />`, "Valfritt.")}
              ${fältrad("Typ", html`<select name="type">${typval("anthropic")}</select>`)}
              ${fältrad("Bas-URL", html`<input type="text" name="base_url" placeholder="https://api.openai.com/v1" />`, "Bara för OpenAI-kompatibla.")}
              ${fältrad("Standardmodell", html`<input type="text" name="model" list="modeller" placeholder="${STANDARDMODELL.anthropic}" />`)}
              ${fältrad("API-nyckel", html`<input type="password" name="api_key" autocomplete="off" />`)}
              <div class="knappar"><button>Skapa leverantör</button></div>
            </form>
          </div>
        </details>
        <h2>Förbrukning, 30 dagar <span class="dim">· tokens in och ut</span></h2>
        ${användning.length
          ? html`<div class="lista tabell"><table>
              <thead><tr><th>Leverantör</th><th>Modell</th><th class="tal">Anrop</th><th class="tal">In</th><th class="tal">Ut</th></tr></thead>
              <tbody>${användning.map(
                (r) => html`<tr><td>${r.provider_id}</td><td>${r.model}</td><td class="tal">${tal(r.anrop)}</td><td class="tal">${tal(r.tin)}</td><td class="tal">${tal(r.tut)}</td></tr>`,
              )}</tbody></table></div>`
          : html`<div class="kort"><p class="tips" style="margin:0">Inga anrop de senaste 30 dagarna.</p></div>`}`,
      "/admin/leverantorer",
    ),
    status,
  );
}

function läsTyp(v: string): Typ | null {
  return (TYPER as readonly string[]).includes(v) ? (v as Typ) : null;
}

function giltigBasUrl(v: string): boolean {
  if (!v) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

async function skapaLeverantör(req: Request, env: Env, s: Inställningar, url: URL): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  const id = fält(f, "id") || slug(namn);
  const typ = läsTyp(fält(f, "type"));
  const nyckel = fält(f, "api_key");
  if (!namn || !typ) return leverantörSida(env, s, url, "Leverantören behöver namn och typ.", 400);
  if (!MÅL_ID.test(id)) return leverantörSida(env, s, url, `Id:t "${id}" går inte: gemener, siffror, - _ .`, 400);
  if (!giltigBasUrl(fält(f, "base_url"))) return leverantörSida(env, s, url, "Bas-URL:en är inte en adress.", 400);
  if (nyckel && !env.KEY_SECRET) return leverantörSida(env, s, url, "KEY_SECRET saknas, nyckeln kan inte sparas.", 400);
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO providers (id, name, type, base_url, api_key, key_hint, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      namn,
      typ,
      fält(f, "base_url") || null,
      nyckel ? await kryptera(env.KEY_SECRET, nyckel) : null,
      nyckel ? maskera(nyckel) : null,
      fält(f, "model") || null,
      nu(),
    )
    .run();
  if (!r.meta.changes) return leverantörSida(env, s, url, `Det finns redan en leverantör med id "${id}".`, 409);
  await revisionslogg(env, req, "leverantor.andrad", `${namn} (${id}) skapad${nyckel ? `, API-nyckel ${maskera(nyckel)}` : ""}`);
  return medMeddelande("/admin/leverantorer", `${namn} är skapad.`);
}

async function ändraLeverantör(req: Request, env: Env, s: Inställningar, url: URL, id: string): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  const typ = läsTyp(fält(f, "type"));
  const nyckel = fält(f, "api_key");
  if (!namn || !typ) return leverantörSida(env, s, url, "Leverantören behöver namn och typ.", 400);
  if (!giltigBasUrl(fält(f, "base_url"))) return leverantörSida(env, s, url, "Bas-URL:en är inte en adress.", 400);
  if (nyckel && !env.KEY_SECRET) return leverantörSida(env, s, url, "KEY_SECRET saknas, nyckeln kan inte sparas.", 400);
  const r = await env.DB.prepare("UPDATE providers SET name = ?, type = ?, base_url = ?, model = ? WHERE id = ?")
    .bind(namn, typ, fält(f, "base_url") || null, fält(f, "model") || null, id)
    .run();
  if (!r.meta.changes) throw new EjFunnen();
  if (nyckel) {
    await env.DB.prepare("UPDATE providers SET api_key = ?, key_hint = ? WHERE id = ?")
      .bind(await kryptera(env.KEY_SECRET, nyckel), maskera(nyckel), id)
      .run();
  } else if (f.has("remove_key")) {
    await env.DB.prepare("UPDATE providers SET api_key = NULL, key_hint = NULL WHERE id = ?").bind(id).run();
  }
  await revisionslogg(
    env,
    req,
    "leverantor.andrad",
    `${namn} (${id})${nyckel ? `, ny API-nyckel ${maskera(nyckel)}` : f.has("remove_key") ? ", API-nyckeln borttagen" : ""}`,
  );
  return medMeddelande("/admin/leverantorer", `${namn} är sparad.`);
}

async function taBortLeverantör(req: Request, env: Env, s: Inställningar, id: string): Promise<Response> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE provider_id = ?").bind(id).first<{ n: number }>();
  if (n?.n) return medMeddelande("/admin/leverantorer", `Leverantören används av ${n.n} prompter; ändra dem först.`);
  if (s.chatProvider === id) return medMeddelande("/admin/leverantorer", "Leverantören används för fri fråga under Inställningar.");
  await env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(id).run();
  await revisionslogg(env, req, "leverantor.andrad", `${id} borttagen`);
  return medMeddelande("/admin/leverantorer", "Leverantören är borttagen.");
}

// ---------- Prompter ----------

async function promptSida(env: Env, s: Inställningar, url: URL, fel: string | null = null, status = 200): Promise<Response> {
  const [prompter, { results: leverantörer }, { results: avsändare }, { results: tilldelade }] = await Promise.all([
    allaPrompter(env.DB),
    env.DB.prepare("SELECT id, name, type FROM providers ORDER BY name").all<{ id: string; name: string; type: Typ }>(),
    env.DB.prepare("SELECT id, name, key_hint FROM senders ORDER BY name").all<{ id: string; name: string; key_hint: string | null }>(),
    env.DB.prepare("SELECT sender_id, prompt_id FROM sender_prompts").all<{ sender_id: string; prompt_id: string }>(),
  ]);
  const levNamn = new Map(leverantörer.map((l) => [l.id, l.name]));
  const levVal = (vald: string) =>
    leverantörer.map((l) => html`<option value="${l.id}"${raw(l.id === vald ? " selected" : "")}>${l.name}</option>`);
  const avsVal = (valda: string[]) =>
    avsändare.length
      ? avsändare.map(
          (a) => html`<label class="val"><input type="checkbox" name="senders" value="${a.id}"${raw(valda.includes(a.id) ? " checked" : "")} />
            ${a.name}${a.key_hint ? "" : html` <span class="dim">spärrad</span>`}</label>`,
        )
      : html`<span class="tips">Inga avsändare än.</span>`;
  const sortVal = (vald: string) =>
    html`<option value="summary"${raw(vald === "summary" ? " selected" : "")}>Sammanfattning</option>
      <option value="chat"${raw(vald === "chat" ? " selected" : "")}>Chatt (snabbval)</option>`;

  const fälten = (p: Partial<Prompt>, valda: string[]) => html`
    ${fältrad("Namn", html`<input type="text" name="name" value="${p.name ?? ""}" required />`)}
    ${fältrad("Beskrivning", html`<input type="text" name="description" value="${p.description ?? ""}" />`, "Visas i appen.")}
    ${fältrad("Sort", html`<select name="kind">${sortVal(p.kind ?? "summary")}</select>`)}
    ${växel("live", "Får användas under pågående inspelning", !!p.live)}
    ${fältrad("Leverantör", html`<select name="provider">${levVal(p.provider_id ?? leverantörer[0]?.id ?? "")}</select>`)}
    ${fältrad("Modell", html`<input type="text" name="model" value="${p.model ?? ""}" list="modeller" placeholder="Leverantörens standard" />`)}
    ${fältrad("Systemtext", html`<textarea name="system" rows="3" placeholder="Mottagarens, se Inställningar">${p.system ?? ""}</textarea>`)}
    ${fältrad(
      "Användartext",
      html`<textarea name="user_text" rows="5" required>${p.user_text ?? ""}</textarea>`,
      "Sammanfattning: instruktionen som ger avsnitten. Chatt: snabbvalets fråga.",
    )}
    ${valgrupp("Vilka får använda den", avsVal(valda))}`;

  return htmlSvar(
    sida(
      s,
      "Prompter",
      html`${rubrik("Prompter", "Sammanfattningar och snabbfrågor som avsändarna kan välja i appen. Transkriptet skickas alltid med.")}
        ${meddelande(url)} ${felruta(fel)} ${modellista()}
        ${prompter.length
          ? html`<div class="lista">
              ${prompter.map((p, i) => {
                const valda = tilldelade.filter((t) => t.prompt_id === p.id).map((t) => t.sender_id);
                return html`<details class="post">
                  <summary>
                    <div class="radtext">
                      <div class="namn">${p.name}</div>
                      <div class="meta">${sortnamn(p)} · ${levNamn.get(p.provider_id) ?? p.provider_id} · ${valda.length} avsändare</div>
                    </div>
                    <span class="chev">›</span>
                  </summary>
                  <div class="postinnehall">
                    <form id="ta-bort-prompt-${i}" method="post" action="/admin/prompter/${encodeURIComponent(p.id)}/ta-bort"
                      data-bekrafta="Ta bort prompten?"></form>
                    <form method="post" action="/admin/prompter/${encodeURIComponent(p.id)}">
                      ${fälten(p, valda)}
                      <p class="tips">Id <code>${p.id}</code></p>
                      <div class="knappar">
                        <button>Spara</button>
                        <span class="hoger"><button class="farlig" form="ta-bort-prompt-${i}">Ta bort</button></span>
                      </div>
                    </form>
                  </div>
                </details>`;
              })}
            </div>`
          : tomt("Inga prompter än.")}
        ${leverantörer.length
          ? html`<details class="lista post ny"${raw(!prompter.length || fel ? " open" : "")}>
              <summary><span class="plus">+</span><span class="radtext">Ny prompt</span></summary>
              <div class="postinnehall">
                <form method="post" action="/admin/prompter">
                  ${fälten({}, [])}
                  ${fältrad("Id", html`<input type="text" name="id" placeholder="Av namnet, t.ex. beslut" />`, "Valfritt.")}
                  <div class="knappar"><button>Skapa prompt</button></div>
                </form>
              </div>
            </details>`
          : html`<div class="kort"><p class="tips" style="margin:0"><a href="/admin/leverantorer">Lägg till en leverantör</a> först.</p></div>`}`,
      "/admin/prompter",
    ),
    status,
  );
}

interface Promptfält {
  name: string;
  description: string;
  kind: "summary" | "chat";
  live: number;
  provider: string;
  model: string | null;
  system: string;
  user_text: string;
}

async function läsPrompt(env: Env, f: FormData): Promise<Promptfält | string> {
  const p: Promptfält = {
    name: fält(f, "name"),
    description: fält(f, "description"),
    kind: fält(f, "kind") === "chat" ? "chat" : "summary",
    live: f.has("live") ? 1 : 0,
    provider: fält(f, "provider"),
    model: fält(f, "model") || null,
    system: fält(f, "system"),
    user_text: fält(f, "user_text"),
  };
  if (!p.name) return "Prompten behöver ett namn.";
  if (!p.user_text) return "Prompten behöver en användartext.";
  if (!(await env.DB.prepare("SELECT 1 FROM providers WHERE id = ?").bind(p.provider).first())) return "Välj en leverantör.";
  return p;
}

async function sättAvsändare(db: D1Database, prompt: string, avsändare: string[]): Promise<void> {
  const { results } = await db.prepare("SELECT id FROM senders").all<{ id: string }>();
  const giltiga = new Set(results.map((r) => r.id));
  await db.batch([
    db.prepare("DELETE FROM sender_prompts WHERE prompt_id = ?").bind(prompt),
    ...[...new Set(avsändare)]
      .filter((a) => giltiga.has(a))
      .map((a) => db.prepare("INSERT INTO sender_prompts (sender_id, prompt_id) VALUES (?, ?)").bind(a, prompt)),
  ]);
}

async function skapaPrompt(req: Request, env: Env, s: Inställningar, url: URL): Promise<Response> {
  const f = await formulär(req);
  const p = await läsPrompt(env, f);
  if (typeof p === "string") return promptSida(env, s, url, p, 400);
  const id = fält(f, "id") || slug(p.name);
  if (!MÅL_ID.test(id)) return promptSida(env, s, url, `Id:t "${id}" går inte: gemener, siffror, - _ .`, 400);
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO prompts (id, name, description, kind, live, provider_id, model, system, user_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, p.name, p.description, p.kind, p.live, p.provider, p.model, p.system, p.user_text, nu())
    .run();
  if (!r.meta.changes) return promptSida(env, s, url, `Det finns redan en prompt med id "${id}".`, 409);
  await sättAvsändare(env.DB, id, flera(f, "senders"));
  await revisionslogg(env, req, "prompt.andrad", `${p.name} (${id}) skapad`);
  return medMeddelande("/admin/prompter", `Prompten ${p.name} är skapad.`);
}

async function ändraPrompt(req: Request, env: Env, s: Inställningar, url: URL, id: string): Promise<Response> {
  const f = await formulär(req);
  const p = await läsPrompt(env, f);
  if (typeof p === "string") return promptSida(env, s, url, p, 400);
  const r = await env.DB.prepare(
    `UPDATE prompts SET name = ?, description = ?, kind = ?, live = ?, provider_id = ?, model = ?, system = ?, user_text = ?
     WHERE id = ?`,
  )
    .bind(p.name, p.description, p.kind, p.live, p.provider, p.model, p.system, p.user_text, id)
    .run();
  if (!r.meta.changes) throw new EjFunnen();
  await sättAvsändare(env.DB, id, flera(f, "senders"));
  await revisionslogg(env, req, "prompt.andrad", `${p.name} (${id})`);
  return medMeddelande("/admin/prompter", `${p.name} är sparad.`);
}

async function taBortPrompt(req: Request, env: Env, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sender_prompts WHERE prompt_id = ?").bind(id),
    env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(id),
  ]);
  await revisionslogg(env, req, "prompt.andrad", `${id} borttagen`);
  return medMeddelande("/admin/prompter", "Prompten är borttagen.");
}

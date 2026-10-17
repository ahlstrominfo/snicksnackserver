// Admin för extern AI: leverantörer (/admin/leverantorer) och prompter (/admin/prompter).

import { EjFunnen, felruta, fält, flera, formulär, medMeddelande, meddelande, sida } from "./admin";
import type { Prompt } from "./ai/anrop";
import { MODELLFÖRSLAG, STANDARDMODELL, TYPER, type Leverantör, type Typ } from "./ai/leverantorer";
import { MÅL_ID, nu, slug, type Inställningar } from "./db";
import { html, htmlSvar, raw, type Raw } from "./html";
import { kryptera, maskera } from "./krypto";

const TYPNAMN: Record<Typ, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI-kompatibel (OpenAI, Mistral, Azure, Ollama …)",
  test: "Test (ingen AI, ingen nyckel)",
};

/** Hanterar /admin/leverantorer… och /admin/prompter…; null = finns inte. */
export async function adminAi(req: Request, env: Env, s: Inställningar, delar: string[], url: URL): Promise<Response | null> {
  const post = req.method === "POST";
  if (delar[0] === "leverantorer") {
    if (delar.length === 1) return post ? skapaLeverantör(req, env, s, url) : leverantörSida(env, s, url);
    if (delar.length === 2 && post) return ändraLeverantör(req, env, s, url, delar[1]);
    if (delar.length === 3 && delar[2] === "ta-bort" && post) return taBortLeverantör(env, s, delar[1]);
  }
  if (delar[0] === "prompter") {
    if (delar.length === 1) return post ? skapaPrompt(req, env, s, url) : promptSida(env, s, url);
    if (delar.length === 2 && post) return ändraPrompt(req, env, s, url, delar[1]);
    if (delar.length === 3 && delar[2] === "ta-bort" && post) return taBortPrompt(env, delar[1]);
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
  if (!prompter.length) return html`<p class="dim">Inga prompter än. <a href="/admin/prompter">Skapa en prompt</a>.</p>`;
  return html`${prompter.map(
    (p) =>
      html`<label class="val"><input type="checkbox" name="prompts" value="${p.id}"${raw(valda.includes(p.id) ? " checked" : "")} />
        ${p.name} <span class="dim">(${sortnamn(p)})</span></label>`,
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
    : html`<p class="fel">KEY_SECRET saknas: API-nycklar går inte att spara. Kör <code>npx wrangler secret put KEY_SECRET</code>.</p>`;

  return htmlSvar(
    sida(
      s,
      "Leverantörer",
      html`<h1>Leverantörer</h1>
        <p class="dim">Var AI-anropen går. Nycklarna sparas krypterade och visas aldrig igen; lämna fältet tomt för att behålla
          den sparade.</p>
        ${meddelande(url)} ${felruta(fel)} ${utanSecret} ${modellista()}
        ${leverantörer.map(
          (l) => html`<div class="kort">
            <form method="post" action="/admin/leverantorer/${encodeURIComponent(l.id)}">
              <div><code>${l.id}</code> <span class="dim">· ${TYPNAMN[l.type]} · ${promptantal.get(l.id) ?? 0} prompter
                ${l.type !== "test" ? html` · nyckel ${l.key_hint ?? "saknas"}` : ""}</span></div>
              <label>Namn</label><input type="text" name="name" value="${l.name}" required />
              <label>Typ</label><select name="type">${typval(l.type)}</select>
              <label>Bas-URL <span class="dim">(bara OpenAI-kompatibel; tom = https://api.openai.com/v1)</span></label>
              <input type="text" name="base_url" value="${l.base_url ?? ""}" placeholder="https://api.mistral.ai/v1" />
              <label>Standardmodell <span class="dim">(tom = ${STANDARDMODELL[l.type]})</span></label>
              <input type="text" name="model" value="${l.model ?? ""}" list="modeller" />
              ${l.type !== "test"
                ? html`<label>API-nyckel</label>
                    <input type="password" name="api_key" autocomplete="off" placeholder="${l.key_hint ? `oförändrad (${l.key_hint})` : "ingen sparad"}" />
                    ${l.key_hint ? html`<label class="val"><input type="checkbox" name="remove_key" /> Ta bort nyckeln</label>` : ""}`
                : ""}
              <div class="rad"><button>Spara</button></div>
            </form>
            <form method="post" action="/admin/leverantorer/${encodeURIComponent(l.id)}/ta-bort" class="rad"
              onsubmit="return confirm('Ta bort leverantören?')">
              <button class="farlig">Ta bort</button>
            </form>
          </div>`,
        )}
        <h2>Ny leverantör</h2>
        <form method="post" action="/admin/leverantorer" class="kort">
          <label>Namn</label><input type="text" name="name" required placeholder="Claude" />
          <label>Id <span class="dim">(valfritt; annars av namnet)</span></label><input type="text" name="id" placeholder="claude" />
          <label>Typ</label><select name="type">${typval("anthropic")}</select>
          <label>Bas-URL <span class="dim">(bara OpenAI-kompatibel)</span></label>
          <input type="text" name="base_url" placeholder="https://api.openai.com/v1" />
          <label>Standardmodell</label><input type="text" name="model" list="modeller" placeholder="${STANDARDMODELL.anthropic}" />
          <label>API-nyckel</label><input type="password" name="api_key" autocomplete="off" />
          <div class="rad"><button>Skapa leverantör</button></div>
        </form>
        <h2>Förbrukning, 30 dagar</h2>
        ${användning.length
          ? html`<div class="tabell"><table><thead><tr><th>Leverantör</th><th>Modell</th><th>Anrop</th><th>Tokens in</th><th>Tokens ut</th></tr></thead>
              <tbody>${användning.map(
                (r) => html`<tr><td>${r.provider_id}</td><td>${r.model}</td><td>${r.anrop}</td><td>${r.tin}</td><td>${r.tut}</td></tr>`,
              )}</tbody></table></div>`
          : html`<p class="dim">Inga anrop än.</p>`}`,
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
  return medMeddelande("/admin/leverantorer", `${namn} är sparad.`);
}

async function taBortLeverantör(env: Env, s: Inställningar, id: string): Promise<Response> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE provider_id = ?").bind(id).first<{ n: number }>();
  if (n?.n) return medMeddelande("/admin/leverantorer", `Leverantören används av ${n.n} prompter; ändra dem först.`);
  if (s.chatProvider === id) return medMeddelande("/admin/leverantorer", "Leverantören används för fri fråga under Inställningar.");
  await env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(id).run();
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
  const levVal = (vald: string) =>
    leverantörer.map((l) => html`<option value="${l.id}"${raw(l.id === vald ? " selected" : "")}>${l.name}</option>`);
  const avsVal = (valda: string[]) =>
    avsändare.length
      ? avsändare.map(
          (a) => html`<label class="val"><input type="checkbox" name="senders" value="${a.id}"${raw(valda.includes(a.id) ? " checked" : "")} />
            ${a.name}${a.key_hint ? "" : html` <span class="dim">(spärrad)</span>`}</label>`,
        )
      : html`<p class="dim">Inga avsändare än.</p>`;
  const sortVal = (vald: string) =>
    html`<option value="summary"${raw(vald === "summary" ? " selected" : "")}>Sammanfattning (summarize)</option>
      <option value="chat"${raw(vald === "chat" ? " selected" : "")}>Chatt (snabbval)</option>`;

  const fälten = (p: Partial<Prompt>, valda: string[]) => html`
    <label>Namn</label><input type="text" name="name" value="${p.name ?? ""}" required />
    <label>Beskrivning <span class="dim">(visas i appen)</span></label><input type="text" name="description" value="${p.description ?? ""}" />
    <label>Sort</label><select name="kind">${sortVal(p.kind ?? "summary")}</select>
    <div><label class="val"><input type="checkbox" name="live"${raw(p.live ? " checked" : "")} /> Får användas under pågående inspelning (live)</label></div>
    <label>Leverantör</label><select name="provider">${levVal(p.provider_id ?? leverantörer[0]?.id ?? "")}</select>
    <label>Modell <span class="dim">(tom = leverantörens standard)</span></label><input type="text" name="model" value="${p.model ?? ""}" list="modeller" />
    <label>Systemtext <span class="dim">(tom = mottagarens, se Inställningar)</span></label>
    <textarea name="system" rows="3">${p.system ?? ""}</textarea>
    <label>Användartext <span class="dim">(sammanfattning: instruktionen som ger avsnitten; chatt: snabbvalets fråga)</span></label>
    <textarea name="user_text" rows="4" required>${p.user_text ?? ""}</textarea>
    <label>Avsändare som får använda den</label>${avsVal(valda)}`;

  return htmlSvar(
    sida(
      s,
      "Prompter",
      html`<h1>Prompter</h1>
        <p class="dim">Sammanfattningar och chattens snabbval som avsändarna kan använda i Snicksnack. Transkriptet och
          anteckningen läggs alltid i systemprompten.</p>
        ${meddelande(url)} ${felruta(fel)} ${modellista()}
        ${prompter.map(
          (p) => html`<div class="kort">
            <form method="post" action="/admin/prompter/${encodeURIComponent(p.id)}">
              <div><code>${p.id}</code> <span class="dim">· ${sortnamn(p)}</span></div>
              ${fälten(p, tilldelade.filter((t) => t.prompt_id === p.id).map((t) => t.sender_id))}
              <div class="rad"><button>Spara</button></div>
            </form>
            <form method="post" action="/admin/prompter/${encodeURIComponent(p.id)}/ta-bort" class="rad"
              onsubmit="return confirm('Ta bort prompten?')">
              <button class="farlig">Ta bort</button>
            </form>
          </div>`,
        )}
        ${prompter.length ? "" : html`<p class="dim">Inga prompter än.</p>`}
        <h2>Ny prompt</h2>
        ${leverantörer.length
          ? html`<form method="post" action="/admin/prompter" class="kort">
              <label>Id <span class="dim">(valfritt; annars av namnet)</span></label><input type="text" name="id" placeholder="beslut" />
              ${fälten({}, [])}
              <div class="rad"><button>Skapa prompt</button></div>
            </form>`
          : html`<p class="dim"><a href="/admin/leverantorer">Skapa en leverantör</a> först.</p>`}`,
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
  return medMeddelande("/admin/prompter", `${p.name} är sparad.`);
}

async function taBortPrompt(env: Env, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sender_prompts WHERE prompt_id = ?").bind(id),
    env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(id),
  ]);
  return medMeddelande("/admin/prompter", "Prompten är borttagen.");
}

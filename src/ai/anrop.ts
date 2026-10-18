// Extern AI via mottagaren (docs/protokoll.md, avsnitt 4–6): promptlistan, summarize och chat.
// Statelöst: inget av innehållet sparas, bara antal anrop och tokens i tabellen usage.

import { hämtaInställningar, nu, type Avsändare } from "../db";
import { aiStopp } from "../kvoter";
import { fel, förMånga, inloggadAvsändare, json, ogiltigNyckel } from "../protokoll";
import { tillåt } from "../ratelimit";
import {
  hämtaLeverantör,
  LeverantörsFel,
  somLeverantörsFel,
  STANDARDMODELL,
  städa,
  strukturerat,
  strömma,
  type Användning,
  type Fråga,
  type Leverantör,
  type Meddelande,
} from "./leverantorer";
import {
  FORMINSTRUKTION,
  markdown,
  systemprompt,
  talarIdn,
  tolkaSammanfattning,
  type Transkript,
} from "./transkript";

export interface Prompt {
  id: string;
  name: string;
  description: string;
  kind: "summary" | "chat";
  live: number;
  provider_id: string;
  model: string | null;
  system: string;
  user_text: string;
  created_at: string;
}

export async function promptFörAvsändare(db: D1Database, avsändare: string, id: string): Promise<Prompt | null> {
  return db
    .prepare(
      `SELECT p.* FROM prompts p JOIN sender_prompts sp ON sp.prompt_id = p.id WHERE p.id = ? AND sp.sender_id = ?`,
    )
    .bind(id, avsändare)
    .first<Prompt>();
}

export async function prompterFörAvsändare(db: D1Database, avsändare: string): Promise<Prompt[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM prompts p JOIN sender_prompts sp ON sp.prompt_id = p.id WHERE sp.sender_id = ?
       ORDER BY p.kind DESC, p.created_at, p.name`,
    )
    .bind(avsändare)
    .all<Prompt>();
  return results;
}

/** Vilka sorters prompter som finns alls (för well-known). */
export async function promptsorter(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT DISTINCT kind FROM prompts").all<{ kind: string }>();
  return new Set(results.map((r) => r.kind));
}

export async function listaPrompter(req: Request, env: Env): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return ogiltigNyckel(req, env);
  const prompter = await prompterFörAvsändare(env.DB, avsändare.id);
  return json({
    prompts: prompter.map((p) => ({ id: p.id, name: p.name, description: p.description, kind: p.kind, live: !!p.live })),
  });
}

/** Läser JSON-kroppen med storleksgräns. Ett Response betyder fel. */
async function läsKropp(req: Request, env: Env): Promise<Record<string, unknown> | Response> {
  const max = Number(env.AI_MAX_BYTES) || 20 * 1024 * 1024;
  if (Number(req.headers.get("Content-Length") ?? 0) > max) return fel(413, `För stort: högst ${max} byte`);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > max) return fel(413, `För stort: högst ${max} byte`);
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // faller igenom
  }
  return fel(400, "Kroppen ska vara ett JSON-objekt");
}

/** Rate limit och kvoter före ett AI-anrop: 429 med en text som appen visar, eller null. */
async function aiSpärr(env: Env, avsändare: Avsändare): Promise<Response | null> {
  if (!(await tillåt(env, "ai", avsändare.id))) return förMånga("ai", "För många AI-anrop på kort tid. Vänta en minut och försök igen.");
  const stopp = await aiStopp(env.DB, avsändare);
  return stopp ? fel(429, stopp) : null;
}

async function leverantörFör(env: Env, id: string): Promise<Leverantör> {
  const l = await hämtaLeverantör(env.DB, id);
  if (!l) throw new LeverantörsFel(`Leverantören ${id} finns inte`, 500);
  return l;
}

async function räkna(
  env: Env,
  rad: { avsändare: string; prompt: string | null; sort: "summary" | "chat"; leverantör: string; modell: string },
  anv: Användning,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (day, sender_id, prompt_id, kind, provider_id, model, requests, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(day, sender_id, prompt_id, kind, provider_id, model) DO UPDATE SET
       requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  )
    .bind(nu().slice(0, 10), rad.avsändare, rad.prompt ?? "", rad.sort, rad.leverantör, rad.modell, anv.input, anv.output)
    .run();
}

// ---------- POST <summarize>/<prompt-id> ----------

export async function sammanfatta(req: Request, env: Env, ctx: ExecutionContext, rådId: string): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return ogiltigNyckel(req, env);
  const spärr = await aiSpärr(env, avsändare);
  if (spärr) return spärr;
  let id: string;
  try {
    id = decodeURIComponent(rådId);
  } catch {
    return fel(404, "Okänd prompt");
  }
  const prompt = await promptFörAvsändare(env.DB, avsändare.id, id);
  if (!prompt) return fel(404, "Okänd prompt");
  if (prompt.kind !== "summary") return fel(400, "Prompten är en chattprompt; använd chat");

  const kropp = await läsKropp(req, env);
  if (kropp instanceof Response) return kropp;
  const t = kropp as Transkript;

  const anv: Användning = { input: 0, output: 0 };
  let leverantör: Leverantör;
  try {
    leverantör = await leverantörFör(env, prompt.provider_id);
  } catch (e) {
    const f = somLeverantörsFel(e);
    return fel(f.status, f.message);
  }
  const modell = prompt.model || leverantör.model || STANDARDMODELL[leverantör.type];
  const fråga: Fråga = {
    system: systemprompt(t, prompt.system, { live: false, läge: "sammanfattning" }),
    messages: [{ role: "user", content: `${prompt.user_text.trim() || "Sammanfatta snacket."}\n\n${FORMINSTRUKTION}` }],
    model: modell,
    transkript: t,
  };

  const talare = talarIdn(t);
  const längd = typeof t.duration === "number" && isFinite(t.duration) ? t.duration : null;
  let punkter = null;
  try {
    for (let försök = 0; försök < 2 && !punkter; försök++) {
      punkter = tolkaSammanfattning(await strukturerat(env, leverantör, fråga, anv), talare, längd);
    }
  } catch (e) {
    const f = somLeverantörsFel(e);
    console.error("summarize:", f.message);
    return fel(f.status, f.message);
  } finally {
    ctx.waitUntil(
      räkna(env, { avsändare: avsändare.id, prompt: prompt.id, sort: "summary", leverantör: leverantör.id, modell }, anv).catch(
        (e) => console.error("usage:", e),
      ),
    );
  }
  if (!punkter) return fel(502, "Modellens svar följde inte formen, inte heller andra gången");

  return json({
    summary: { kind: "custom", name: prompt.name, prompt: prompt.id, created_at: nu(), items: punkter },
    markdown: markdown(punkter),
  });
}

// ---------- POST <chat> ----------

function läsMeddelanden(v: unknown): Meddelande[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const ut: Meddelande[] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    if (content.trim()) ut.push({ role, content });
  }
  return ut;
}

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

export async function chatta(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return ogiltigNyckel(req, env);
  const spärr = await aiSpärr(env, avsändare);
  if (spärr) return spärr;
  const kropp = await läsKropp(req, env);
  if (kropp instanceof Response) return kropp;

  const live = kropp.live === true;
  const meddelanden = läsMeddelanden(kropp.messages);
  if (!meddelanden) return fel(400, "messages ska vara en lista med {role, content}");
  const t = (kropp.transcript && typeof kropp.transcript === "object" ? kropp.transcript : {}) as Transkript;

  let prompt: Prompt | null = null;
  let leverantörsId: string;
  let modell: string | null;
  let systemtext: string;
  const s = await hämtaInställningar(env.DB);
  if (typeof kropp.prompt === "string" && kropp.prompt) {
    prompt = await promptFörAvsändare(env.DB, avsändare.id, kropp.prompt);
    if (!prompt) return fel(404, "Okänd prompt");
    if (prompt.kind !== "chat") return fel(400, "Prompten är en sammanfattning; använd summarize");
    if (live && !prompt.live) return fel(400, "Prompten får inte användas under inspelning");
    meddelanden.push({ role: "user", content: prompt.user_text.trim() || prompt.name });
    leverantörsId = prompt.provider_id;
    modell = prompt.model;
    systemtext = prompt.system.trim() || s.chatSystem;
  } else {
    // Fri fråga: kräver att avsändaren har minst en chattprompt. Leverantören tas ur inställningarna,
    // annars från den första chattprompten.
    const chattprompter = (await prompterFörAvsändare(env.DB, avsändare.id)).filter((p) => p.kind === "chat");
    if (!chattprompter.length) return fel(404, "Ingen chatt för den här nyckeln");
    leverantörsId = s.chatProvider || chattprompter[0].provider_id;
    modell = s.chatProvider ? s.chatModel : chattprompter[0].model;
    systemtext = s.chatSystem;
  }
  const städat = städa(meddelanden);
  if (!städat.length || städat[städat.length - 1].role !== "user") {
    return fel(400, "Sista meddelandet ska vara användarens fråga");
  }

  let leverantör: Leverantör;
  try {
    leverantör = await leverantörFör(env, leverantörsId);
  } catch (e) {
    const f = somLeverantörsFel(e);
    return fel(f.status, f.message);
  }
  const modellnamn = modell || leverantör.model || STANDARDMODELL[leverantör.type];
  const fråga: Fråga = {
    system: systemprompt(t, systemtext, { live, läge: "chatt" }),
    messages: städat,
    model: modellnamn,
    transkript: t,
  };
  const anv: Användning = { input: 0, output: 0 };
  const avbryt = new AbortController();
  const ström = strömma(env, leverantör, fråga, anv, avbryt.signal);
  const räknaSen = () =>
    räkna(env, { avsändare: avsändare.id, prompt: prompt?.id ?? null, sort: "chat", leverantör: leverantör.id, modell: modellnamn }, anv).catch(
      (e) => console.error("usage:", e),
    );

  // Första biten hämtas innan svaret börjar, så att fel i anslutningen blir ett vanligt JSON-fel.
  let första: IteratorResult<string>;
  try {
    första = await ström.next();
  } catch (e) {
    const f = somLeverantörsFel(e);
    console.error("chat:", f.message);
    ctx.waitUntil(räknaSen());
    return fel(f.status, f.message);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const skrivare = writable.getWriter();
  const kodare = new TextEncoder();
  const skriv = (d: unknown) => skrivare.write(kodare.encode(sse(d)));

  const pump = async () => {
    try {
      if (!första.done) {
        await skriv({ content: första.value });
        for await (const bit of ström) await skriv({ content: bit });
      }
      await skriv({ done: true });
    } catch (e) {
      avbryt.abort();
      const f = somLeverantörsFel(e);
      console.error("chat mitt i:", f.message);
      await skriv({ error: f.message }).catch(() => {});
    } finally {
      await skrivare.close().catch(() => {});
      await räknaSen();
    }
  };
  ctx.waitUntil(pump());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

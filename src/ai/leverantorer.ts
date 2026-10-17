// AI-leverantörer: anthropic (Messages API via SDK:t), openai (OpenAI-kompatibel chat/completions) och test.

import Anthropic from "@anthropic-ai/sdk";
import { dekryptera } from "../krypto";
import { läsJson, SAMMANFATTNINGSSCHEMA, transkriptText, type Transkript } from "./transkript";

export const TYPER = ["anthropic", "openai", "test"] as const;
export type Typ = (typeof TYPER)[number];

export const STANDARDMODELL: Record<Typ, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-4.1-mini", test: "test" };

/** Förslag i admin; modellnamnet är fritt. */
export const MODELLFÖRSLAG: Record<Typ, string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-4-6"],
  openai: ["gpt-4.1-mini", "gpt-4.1", "mistral-large-latest", "llama3.1"],
  test: ["test"],
};

export interface Leverantör {
  id: string;
  name: string;
  type: Typ;
  base_url: string | null;
  api_key: string | null;
  key_hint: string | null;
  model: string | null;
  created_at: string;
}

export interface Meddelande {
  role: "user" | "assistant";
  content: string;
}

export interface Fråga {
  system: string;
  messages: Meddelande[];
  model: string;
  /** Transkriptet, för testleverantören (den svarar utifrån det). */
  transkript: Transkript;
}

export interface Användning {
  input: number;
  output: number;
}

/** Fel från leverantören eller i konfigurationen; status blir svaret före strömmen. */
export class LeverantörsFel extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export async function hämtaLeverantör(db: D1Database, id: string): Promise<Leverantör | null> {
  return db.prepare("SELECT * FROM providers WHERE id = ?").bind(id).first<Leverantör>();
}

async function nyckel(env: Env, l: Leverantör): Promise<string> {
  if (l.type === "test") return "";
  if (!l.api_key) {
    if (l.type === "openai") return ""; // t.ex. Ollama utan nyckel
    throw new LeverantörsFel(`Leverantören ${l.name} saknar API-nyckel`, 500);
  }
  if (!env.KEY_SECRET) throw new LeverantörsFel("KEY_SECRET saknas på servern", 500);
  try {
    return await dekryptera(env.KEY_SECRET, l.api_key);
  } catch {
    throw new LeverantörsFel(`API-nyckeln för ${l.name} går inte att läsa (har KEY_SECRET bytts?)`, 500);
  }
}

/** Slår ihop meddelanden i följd med samma roll och tar bort inledande assistentsvar. */
export function städa(meddelanden: Meddelande[]): Meddelande[] {
  const ut: Meddelande[] = [];
  for (const m of meddelanden) {
    if (!ut.length && m.role === "assistant") continue;
    const sista = ut[ut.length - 1];
    if (sista && sista.role === m.role) sista.content += "\n\n" + m.content;
    else ut.push({ ...m });
  }
  return ut;
}

function feltext(e: unknown): string {
  if (e instanceof LeverantörsFel) return e.message;
  if (e instanceof Anthropic.APIError) {
    const m = (e.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `Anthropic svarade ${e.status ?? "fel"}${m ? `: ${m}` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function somLeverantörsFel(e: unknown): LeverantörsFel {
  if (e instanceof LeverantörsFel) return e;
  return new LeverantörsFel(feltext(e));
}


// ---------- Strömmad text (chatt) ----------

/** En ström av textbitar. Användningen fylls i under tiden. */
export async function* strömma(env: Env, l: Leverantör, f: Fråga, anv: Användning, signal?: AbortSignal): AsyncGenerator<string> {
  const k = await nyckel(env, l);
  if (l.type === "test") yield* testStröm(f, anv);
  else if (l.type === "anthropic") yield* anthropicStröm(l, k, f, anv, signal);
  else yield* openaiStröm(l, k, f, anv, signal);
}

async function* anthropicStröm(l: Leverantör, k: string, f: Fråga, anv: Användning, signal?: AbortSignal) {
  const klient = new Anthropic({ apiKey: k, baseURL: l.base_url || undefined, maxRetries: 1 });
  const ström = klient.messages.stream(
    {
      model: f.model,
      max_tokens: 16000,
      // Transkriptet ligger i systemprompten och är detsamma genom hela chatten: cacha det.
      system: [{ type: "text", text: f.system, cache_control: { type: "ephemeral" } }],
      messages: f.messages,
    },
    { signal },
  );
  try {
    for await (const h of ström) {
      if (h.type === "message_start") {
        const u = h.message.usage;
        anv.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      } else if (h.type === "content_block_delta" && h.delta.type === "text_delta") {
        yield h.delta.text;
      } else if (h.type === "message_delta") {
        anv.output += h.usage.output_tokens ?? 0;
        if (h.delta.stop_reason === "refusal") throw new LeverantörsFel("Modellen avböjde att svara.");
      }
    }
  } catch (e) {
    throw somLeverantörsFel(e);
  }
}

function openaiAdress(l: Leverantör): string {
  const u = new URL(l.base_url || "https://api.openai.com/v1");
  u.pathname = u.pathname.replace(/\/+$/, "") + "/chat/completions";
  return u.toString();
}

function openaiHuvuden(k: string): Record<string, string> {
  // Bearer för OpenAI, Mistral och Ollama; api-key för Azure.
  return k ? { "Content-Type": "application/json", Authorization: `Bearer ${k}`, "api-key": k } : { "Content-Type": "application/json" };
}

async function openaiFel(svar: Response): Promise<LeverantörsFel> {
  const text = (await svar.text().catch(() => "")).slice(0, 300);
  let m = text;
  try {
    m = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
  } catch {
    // inte JSON
  }
  return new LeverantörsFel(`Leverantören svarade ${svar.status}${m ? `: ${m}` : ""}`);
}

async function* openaiStröm(l: Leverantör, k: string, f: Fråga, anv: Användning, signal?: AbortSignal) {
  let svar: Response;
  try {
    svar = await fetch(openaiAdress(l), {
      method: "POST",
      headers: openaiHuvuden(k),
      body: JSON.stringify({ model: f.model, stream: true, messages: [{ role: "system", content: f.system }, ...f.messages] }),
      signal,
    });
  } catch (e) {
    throw somLeverantörsFel(e);
  }
  if (!svar.ok || !svar.body) throw await openaiFel(svar);
  const läsare = svar.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffert = "";
  for (;;) {
    const { done, value } = await läsare.read();
    if (done) break;
    buffert += value;
    const rader = buffert.split("\n");
    buffert = rader.pop() ?? "";
    for (const rad of rader) {
      const r = rad.trim();
      if (!r.startsWith("data:")) continue;
      const data = r.slice(5).trim();
      if (data === "[DONE]") return;
      let h: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      try {
        h = JSON.parse(data);
      } catch {
        continue;
      }
      if (h.error) throw new LeverantörsFel(h.error.message ?? "Fel från leverantören");
      if (h.usage) {
        anv.input = h.usage.prompt_tokens ?? anv.input;
        anv.output = h.usage.completion_tokens ?? anv.output;
      }
      const bit = h.choices?.[0]?.delta?.content;
      if (bit) yield bit;
    }
  }
}

// ---------- Strukturerat svar (sammanfattning) ----------

/** Modellens JSON-svar, eller null om det inte gick att tolka som JSON. */
export async function strukturerat(env: Env, l: Leverantör, f: Fråga, anv: Användning): Promise<unknown> {
  const k = await nyckel(env, l);
  if (l.type === "test") return testSammanfattning(f, anv);
  if (l.type === "anthropic") {
    const klient = new Anthropic({ apiKey: k, baseURL: l.base_url || undefined, maxRetries: 1 });
    try {
      const svar = await klient.messages
        .stream({
          model: f.model,
          max_tokens: 16000,
          system: f.system,
          messages: f.messages,
          output_config: { format: { type: "json_schema", schema: SAMMANFATTNINGSSCHEMA as unknown as Record<string, unknown> } },
        })
        .finalMessage();
      anv.input += svar.usage.input_tokens ?? 0;
      anv.output += svar.usage.output_tokens ?? 0;
      if (svar.stop_reason === "refusal") throw new LeverantörsFel("Modellen avböjde att svara.");
      const text = svar.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return läsJson(text);
    } catch (e) {
      throw somLeverantörsFel(e);
    }
  }
  let svar: Response;
  try {
    svar = await fetch(openaiAdress(l), {
      method: "POST",
      headers: openaiHuvuden(k),
      body: JSON.stringify({
        model: f.model,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: f.system }, ...f.messages],
      }),
    });
  } catch (e) {
    throw somLeverantörsFel(e);
  }
  if (!svar.ok) throw await openaiFel(svar);
  const data = (await svar.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  anv.input += data.usage?.prompt_tokens ?? 0;
  anv.output += data.usage?.completion_tokens ?? 0;
  return läsJson(data.choices?.[0]?.message?.content ?? "");
}

// ---------- Testleverantören ----------
// Ingen AI: svarar med en fast text byggd på transkriptet. "[fel]" i frågan ger ett fel mitt i strömmen,
// "[fel-före]" ett fel innan den börjar; "[trasig]" i anteckningen ger en sammanfattning i fel form.

const vänta = (ms: number) => new Promise((r) => setTimeout(r, ms));

function meningar(text: string, n: number): string {
  const m = text.match(/[^.!?]+[.!?]+/g) ?? (text ? [text] : []);
  return m.slice(0, n).join(" ").trim();
}

function fakta(t: Transkript) {
  const ord = Array.isArray(t.words) && t.words.length ? t.words.length : (typeof t.text === "string" ? t.text.split(/\s+/).filter(Boolean).length : 0);
  const talare = new Set(Array.isArray(t.words) ? (t.words as { speaker?: unknown }[]).map((o) => o?.speaker).filter((s) => Number.isInteger(s)) : []);
  const text = transkriptText({ ...t, words: [] }, "chatt");
  return { ord, talare: talare.size, början: meningar(text, 2) };
}

async function* testStröm(f: Fråga, anv: Användning): AsyncGenerator<string> {
  const fråga = [...f.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (fråga.includes("[fel-före]")) throw new LeverantörsFel("Testleverantören: fel innan strömmen");
  const { ord, talare, början } = fakta(f.transkript);
  const svar =
    `Det här är testleverantören, ingen AI. Transkriptet har ${ord} ord` +
    (talare ? ` och ${talare} talare` : "") +
    `. ${början ? `Det börjar: "${början}"` : "Det är tomt."} Frågan var: "${fråga.slice(0, 200)}"`;
  anv.input += Math.ceil((f.system.length + fråga.length) / 4);
  for (let i = 0; i < svar.length; i += 12) {
    if (fråga.includes("[fel]") && i >= 24) throw new LeverantörsFel("Testleverantören: fel mitt i strömmen");
    await vänta(15);
    const bit = svar.slice(i, i + 12);
    anv.output += 3;
    yield bit;
  }
}

async function testSammanfattning(f: Fråga, anv: Användning): Promise<unknown> {
  const t = f.transkript;
  if (typeof t.note === "string" && t.note.includes("[trasig]")) return { sections: "inte en lista" };
  const { ord, talare } = fakta(t);
  const titel = typeof t.title === "string" && t.title ? t.title : "Snacket";
  const längd = typeof t.duration === "number" ? Math.round(t.duration) : null;
  const första = Array.isArray(t.words) ? (t.words as { text?: unknown; start?: unknown; speaker?: unknown }[]) : [];
  const början = första
    .slice(0, 2)
    .filter((o) => typeof o?.text === "string")
    .map((o) => ({
      text: `Det första som sägs: "${o.text as string}"`,
      speaker: Number.isInteger(o.speaker) ? o.speaker : null,
      at: typeof o.start === "number" ? o.start : null,
    }));
  anv.input += Math.ceil(f.system.length / 4);
  anv.output += 50;
  await vänta(20);
  return {
    sections: [
      {
        title: "Översikt",
        items: [
          { text: `${titel} är ${längd !== null ? `${längd} sekunder` : "okänt"} långt.`, speaker: null, at: null },
          { text: `Det har ${ord} ord och ${talare} talare.`, speaker: null, at: null },
        ],
      },
      {
        title: "Början",
        items: början.length ? början : [{ text: meningar(transkriptText({ ...t, words: [] }, "chatt"), 1) || "Inget sagt än.", speaker: null, at: null }],
      },
    ],
  };
}

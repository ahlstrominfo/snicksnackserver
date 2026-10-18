// Protokollet (docs/protokoll.md): upptäckt, mållista och mottagning.

import {
  avsändareFrånNyckel,
  hämtaInställningar,
  målFörAvsändare,
  nu,
  tilldelatMål,
  type Avsändare,
} from "./db";
import { promptsorter } from "./ai/anrop";
import { efterMottagning } from "./efter-mottagning";
import { lagringStopp } from "./kvoter";
import { klientIp, tillåt, väntetid, type Gräns } from "./ratelimit";
import { indexera } from "./sok";

export const IKON_NYCKEL = "_config/icon.png";

export function json(kropp: unknown, status = 200, huvuden: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(kropp), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...huvuden,
    },
  });
}

export const fel = (status: number, text: string, huvuden: Record<string, string> = {}) => json({ error: text }, status, huvuden);

/** 429 med Retry-After när en rate limit nåtts. */
export const förMånga = (gräns: Gräns, text = "För många anrop. Vänta en minut och försök igen.") =>
  fel(429, text, { "Retry-After": String(väntetid(gräns)) });

/** 401 för en ogiltig nyckel; 429 när samma adress gissat för många gånger (gissning, per IP). */
export async function ogiltigNyckel(req: Request, env: Env): Promise<Response> {
  if (!(await tillåt(env, "gissning", klientIp(req)))) return förMånga("gissning", "För många försök med ogiltig nyckel. Vänta en minut.");
  return fel(401, "Ogiltig nyckel");
}

export async function wellKnown(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  const [s, sorter] = await Promise.all([hämtaInställningar(env.DB), promptsorter(env.DB)]);
  const svar: Record<string, unknown> = {
    name: s.name,
    version: 1,
    auth: "api-key",
    targets: `${origin}/snicksnack/targets`,
    receive: `${origin}/snicksnack/receive`,
    accepts: s.accepts,
  };
  // Appen hämtar alla prompter, också chattens snabbval, från summarize: skicka den så fort någon prompt finns.
  if (sorter.size > 0) svar.summarize = `${origin}/snicksnack/summarize`;
  if (sorter.has("chat")) svar.chat = `${origin}/snicksnack/chat`;
  // Serverns tillägg (inte en del av appens protokoll): MCP för agenter, med agentnyckel eller OAuth.
  svar.mcp = `${origin}/mcp`;
  svar.mcp_auth = ["api-key", "oauth"];
  if (s.color) svar.color = s.color;
  // Versionen i adressen gör att appen hämtar loggan igen när den byts (appen hämtar bara när adressen ändras).
  if (s.icon) svar.icon = `${origin}/icon.png?v=${ikonversion(s.icon)}`;
  return json(svar, 200, { "Cache-Control": "public, max-age=300" });
}

export async function inloggadAvsändare(req: Request, env: Env): Promise<Avsändare | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
  return m ? avsändareFrånNyckel(env.DB, m[1]) : null;
}

export async function targets(req: Request, env: Env): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return ogiltigNyckel(req, env);
  const mål = await målFörAvsändare(env.DB, avsändare.id);
  return json({ targets: mål.map((m) => (m.grp ? { id: m.id, name: m.name, group: m.grp } : { id: m.id, name: m.name })) });
}

/** Snack-id som går att använda i en R2-nyckel och en URL. */
export function rensaSnackId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128);
}

/** Ljudets format ur de första byten: RIFF…WAVE för wav, "ftyp" i byte 4–8 för m4a (MPEG-4). Annars null. */
export function ljudformat(b: Uint8Array): "wav" | "m4a" | null {
  const ascii = (från: number, till: number) => String.fromCharCode(...b.subarray(från, till));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (b.length >= 8 && ascii(4, 8) === "ftyp") return "m4a";
  return null;
}

const ärStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
const ärTal = (v: unknown) => v === undefined || v === null || (typeof v === "number" && isFinite(v));

/** Kontrollerar att transkriptet har rimliga fält (docs/protokoll.md). Felet som text, eller null om det går bra. */
export function transkriptFel(t: Record<string, unknown>): string | null {
  if (t.id !== undefined && t.id !== null && (typeof t.id !== "string" || !t.id.trim())) return "transcript.id ska vara en sträng";
  if (!Array.isArray(t.words)) return "transcript.words ska vara en lista";
  for (const o of t.words) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return "transcript.words ska vara en lista med objekt";
    const ord = o as Record<string, unknown>;
    if (typeof ord.text !== "string") return "Varje ord i transcript.words ska ha text";
    if (!ärTal(ord.start) || !ärTal(ord.end)) return "start och end i transcript.words ska vara tal";
  }
  for (const f of ["title", "recorded_at", "language", "text", "note"]) if (!ärStr(t[f])) return `transcript.${f} ska vara en sträng`;
  if (!ärTal(t.duration)) return "transcript.duration ska vara ett tal";
  if (t.tags !== undefined && t.tags !== null && (!Array.isArray(t.tags) || !t.tags.every((x) => typeof x === "string"))) {
    return "transcript.tags ska vara en lista med strängar";
  }
  if (t.summaries !== undefined && t.summaries !== null && !Array.isArray(t.summaries)) return "transcript.summaries ska vara en lista";
  return null;
}

interface Transkript {
  id?: unknown;
  title?: unknown;
  recorded_at?: unknown;
  duration?: unknown;
  language?: unknown;
  tags?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function receive(req: Request, env: Env, ctx: ExecutionContext, rådMål: string): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return ogiltigNyckel(req, env);
  // 503 och inte 429: appen ger upp en sändning vid 4xx men försöker igen senare vid 5xx (docs/protokoll.md).
  if (!(await tillåt(env, "mottagning", avsändare.id))) {
    return fel(503, "Mottagaren tar emot för många snack just nu. Appen försöker igen om en stund.", { "Retry-After": String(väntetid("mottagning")) });
  }

  let målId: string;
  try {
    målId = decodeURIComponent(rådMål);
  } catch {
    return fel(404, "Okänt mål");
  }
  const mål = await tilldelatMål(env.DB, avsändare.id, målId);
  if (!mål) return fel(404, "Okänt mål");

  const max = Number(env.MAX_BYTES) || 100 * 1024 * 1024;
  const längd = Number(req.headers.get("Content-Length") ?? 0);
  if (längd > max) return fel(413, `För stort: högst ${max} byte`);
  if (!/^multipart\/form-data/i.test(req.headers.get("Content-Type") ?? "")) {
    return fel(400, "Kroppen ska vara multipart/form-data");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fel(400, "Kunde inte läsa multipart-kroppen");
  }

  // Delarna kan komma som filer eller som vanliga fält; båda går bra.
  const del = (namn: string): File | null => {
    const v = form.get(namn) as unknown;
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return new File([v], namn);
    return v as File;
  };
  const transkriptFil = del("transcript");
  const textFil = del("text");
  const ljudFil = del("audio");
  const totalt = [transkriptFil, textFil, ljudFil].reduce((s, f) => s + (f?.size ?? 0), 0);
  if (totalt > max) return fel(413, `För stort: högst ${max} byte`);

  let transkript: Transkript = {};
  let transkriptText: string | null = null;
  if (transkriptFil) {
    transkriptText = await transkriptFil.text();
    try {
      const t = JSON.parse(transkriptText);
      if (t && typeof t === "object" && !Array.isArray(t)) transkript = t;
      else return fel(400, "transcript ska vara ett JSON-objekt");
    } catch {
      return fel(400, "transcript är inte giltig JSON");
    }
    const problem = transkriptFel(transkript as Record<string, unknown>);
    if (problem) return fel(400, problem);
  }

  const råttId = req.headers.get("Idempotency-Key")?.trim() || str(transkript.id) || "";
  const snackId = rensaSnackId(råttId);
  if (!snackId) return fel(400, "Snackets id saknas (Idempotency-Key eller transcript.id)");

  const { accepts } = await hämtaInställningar(env.DB);
  const prefix = `${mål.id}/${avsändare.id}/${snackId}/`;

  // Ljudet ska vara wav eller m4a på riktigt, inte bara till namnet.
  let wav = false;
  const medLjud = !!ljudFil && ljudFil.size > 0 && accepts.includes("audio");
  if (ljudFil && accepts.includes("audio")) {
    const format = ljudformat(new Uint8Array(await ljudFil.slice(0, 16).arrayBuffer()));
    if (!format) return fel(415, "Ljudet ska vara m4a (MPEG-4) eller wav (RIFF/WAVE).");
    wav = format === "wav";
  }

  // Lagringskvoten: det som skickas nu, minus filerna det ersätter.
  const ersätts = new Set<string>();
  if (transkriptText !== null && accepts.includes("transcript")) ersätts.add("transcript.json");
  if (textFil && accepts.includes("text")) ersätts.add("text.md");
  if (medLjud) ["audio.m4a", "audio.wav"].forEach((n) => ersätts.add(n));
  const nya =
    (accepts.includes("transcript") ? (transkriptFil?.size ?? 0) : 0) +
    (accepts.includes("text") ? (textFil?.size ?? 0) : 0) +
    (medLjud ? ljudFil!.size : 0);
  const före = await env.FILER.list({ prefix });
  const gamla = före.objects.filter((o) => ersätts.has(o.key.slice(prefix.length))).reduce((s, o) => s + o.size, 0);
  // 429 och inte 413: appen visar då serverns text (413 blir bara "för stort").
  const fullt = await lagringStopp(env.DB, avsändare.id, nya, gamla);
  if (fullt) return fel(429, fullt);

  const skrivningar: Promise<unknown>[] = [];

  if (transkriptText !== null && accepts.includes("transcript")) {
    skrivningar.push(
      env.FILER.put(prefix + "transcript.json", transkriptText, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      }),
    );
  }
  if (textFil && accepts.includes("text")) {
    skrivningar.push(
      env.FILER.put(prefix + "text.md", textFil, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: { filename: textFil.name },
      }),
    );
  }
  if (ljudFil && accepts.includes("audio")) {
    skrivningar.push(
      env.FILER.put(prefix + (wav ? "audio.wav" : "audio.m4a"), ljudFil, {
        httpMetadata: { contentType: wav ? "audio/wav" : "audio/mp4" },
        customMetadata: { filename: ljudFil.name },
      }),
      // Byter ljudet format tas det gamla bort så att bara en ljudfil ligger kvar.
      env.FILER.delete(prefix + (wav ? "audio.m4a" : "audio.wav")),
    );
  }
  await Promise.all(skrivningar);

  // Delar som inte skickas den här gången ligger kvar från förra sändningen.
  const lista = await env.FILER.list({ prefix });
  const filer = lista.objects.map((o) => o.key.slice(prefix.length)).sort();
  const bytes = lista.objects.reduce((s, o) => s + o.size, 0);

  const taggar = Array.isArray(transkript.tags) ? transkript.tags.filter((t) => typeof t === "string") : [];
  const längdSek = typeof transkript.duration === "number" && isFinite(transkript.duration) ? transkript.duration : null;
  const tid = nu();
  const fanns = await env.DB.prepare("SELECT 1 FROM snacks WHERE target_id = ? AND sender_id = ? AND snack_id = ?")
    .bind(mål.id, avsändare.id, snackId)
    .first();
  await env.DB.prepare(
    `INSERT INTO snacks (target_id, sender_id, snack_id, title, recorded_at, duration, language, tags, files, bytes,
                         received_at, updated_at, sends)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 1)
     ON CONFLICT(target_id, sender_id, snack_id) DO UPDATE SET
       title = excluded.title, recorded_at = excluded.recorded_at, duration = excluded.duration,
       language = excluded.language, tags = excluded.tags, files = excluded.files, bytes = excluded.bytes,
       updated_at = excluded.updated_at, sends = snacks.sends + 1`,
  )
    .bind(
      mål.id,
      avsändare.id,
      snackId,
      str(transkript.title),
      str(transkript.recorded_at),
      längdSek,
      str(transkript.language),
      JSON.stringify(taggar),
      JSON.stringify(filer),
      bytes,
      tid,
    )
    .run();

  // Sökindexet för agenterna (MCP), bara när transkriptet sparas.
  if (transkriptText !== null && accepts.includes("transcript")) {
    await indexera(env.DB, { target: mål.id, sender: avsändare.id, id: snackId }, JSON.parse(transkriptText));
  }

  const origin = new URL(req.url).origin;
  const id = `${mål.id}/${avsändare.id}/${snackId}`;
  const url = `${origin}/admin/snack/${[mål.id, avsändare.id, snackId].map(encodeURIComponent).join("/")}`;

  ctx.waitUntil(
    efterMottagning(
      {
        id,
        url,
        snackId,
        mål: { id: mål.id, name: mål.name },
        avsändare: { id: avsändare.id, name: avsändare.name },
        title: str(transkript.title),
        recordedAt: str(transkript.recorded_at),
        duration: längdSek,
        language: str(transkript.language),
        tags: taggar,
        filer,
        prefix,
        ny: !fanns,
        mottaget: tid,
      },
      env,
    ).catch((e) => console.error("efterMottagning:", e)),
  );

  return json({ id, url }, fanns ? 200 : 201);
}

export function ikonversion(uppladdad: string): string {
  return uppladdad.replace(/\D/g, "");
}

export async function ikon(req: Request, env: Env): Promise<Response> {
  const obj = await env.FILER.get(IKON_NYCKEL, { onlyIf: req.headers });
  if (!obj) return fel(404, "Ingen logga");
  const huvuden = new Headers({
    "Content-Type": "image/png",
    // Med ?v= ändras adressen när loggan byts, så den kan cachas länge.
    "Cache-Control": new URL(req.url).searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    ETag: obj.httpEtag,
  });
  if (!("body" in obj)) return new Response(null, { status: 304, headers: huvuden });
  if (req.method === "HEAD") {
    await obj.body.cancel();
    return new Response(null, { headers: huvuden });
  }
  return new Response(obj.body, { headers: huvuden });
}

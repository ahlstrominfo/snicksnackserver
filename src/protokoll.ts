// Protokollet (docs/protokoll.md): upptäckt, mållista och mottagning.

import {
  avsändareFrånNyckel,
  hämtaInställningar,
  målFörAvsändare,
  nu,
  tilldelatMål,
  type Avsändare,
} from "./db";
import { efterMottagning } from "./efter-mottagning";

export const IKON_NYCKEL = "_config/icon.png";

export function json(kropp: unknown, status = 200, huvuden: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(kropp), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...huvuden },
  });
}

export const fel = (status: number, text: string) => json({ error: text }, status);

export async function wellKnown(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  const s = await hämtaInställningar(env.DB);
  const svar: Record<string, unknown> = {
    name: s.name,
    version: 1,
    auth: "api-key",
    targets: `${origin}/snicksnack/targets`,
    receive: `${origin}/snicksnack/receive`,
    accepts: s.accepts,
  };
  if (s.color) svar.color = s.color;
  // Versionen i adressen gör att appen hämtar loggan igen när den byts (appen hämtar bara när adressen ändras).
  if (s.icon) svar.icon = `${origin}/icon.png?v=${ikonversion(s.icon)}`;
  return json(svar, 200, { "Cache-Control": "public, max-age=300" });
}

async function inloggadAvsändare(req: Request, env: Env): Promise<Avsändare | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
  return m ? avsändareFrånNyckel(env.DB, m[1]) : null;
}

export async function targets(req: Request, env: Env): Promise<Response> {
  const avsändare = await inloggadAvsändare(req, env);
  if (!avsändare) return fel(401, "Ogiltig nyckel");
  const mål = await målFörAvsändare(env.DB, avsändare.id);
  return json({ targets: mål.map((m) => (m.grp ? { id: m.id, name: m.name, group: m.grp } : { id: m.id, name: m.name })) });
}

/** Snack-id som går att använda i en R2-nyckel och en URL. */
export function rensaSnackId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128);
}

function ärWav(fil: File): boolean {
  return /wav/i.test(fil.type) || /\.wav$/i.test(fil.name);
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
  if (!avsändare) return fel(401, "Ogiltig nyckel");

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
  }

  const råttId = req.headers.get("Idempotency-Key")?.trim() || str(transkript.id) || "";
  const snackId = rensaSnackId(råttId);
  if (!snackId) return fel(400, "Snackets id saknas (Idempotency-Key eller transcript.id)");

  const { accepts } = await hämtaInställningar(env.DB);
  const prefix = `${mål.id}/${avsändare.id}/${snackId}/`;
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
    const wav = ärWav(ljudFil);
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

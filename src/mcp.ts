// MCP-servern på /mcp (Streamable HTTP, statelös, JSON-svar) för agenter med en agentnyckel eller en OAuth-token
// (claude.ai:s kopplare, se oauth.ts).
// Verktygen läser snacken i D1 och R2 inom nyckelns omfång. Ljudet nås via en signerad länk till /ljud/<token>.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { agentFrånAnrop, type Omfång } from "./agenter";
import { oauthFrånAnrop, obehörig } from "./oauth";
import { transkriptText, talarnamn, type Transkript } from "./ai/transkript";
import { hämtaInställningar } from "./db";
import { signera, verifiera } from "./krypto";
import { FILHUVUDEN } from "./html";
import { fel, json } from "./protokoll";
import { klientIp, tillåt, väntetid } from "./ratelimit";
import { revisionslogg } from "./revision";
import { ftsFråga } from "./sok";

const LJUDLÄNK_SEKUNDER = 3600;

// ---------- Ingång ----------

export async function mcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Agentnyckeln (Claude Code, Cursor …) först; allt annat prövas som OAuth-token.
  const huvud = req.headers.get("Authorization") ?? "";
  const harToken = /^Bearer\s+\S/i.test(huvud);
  const omfång = /^Bearer\s+ssk_agent_/i.test(huvud)
    ? await agentFrånAnrop(req, env, ctx)
    : harToken
      ? await oauthFrånAnrop(req, env, ctx)
      : null;
  if (!omfång) {
    if (harToken && !(await tillåt(env, "gissning", klientIp(req)))) return mcpFörMånga("För många försök med ogiltig nyckel. Vänta en minut.");
    return obehörig(req, harToken);
  }
  if (!(await tillåt(env, "mcp", omfång.nyckel))) return mcpFörMånga("För många anrop. Vänta en minut och försök igen.");
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response("Snicksnack MCP: POST JSON-RPC hit.\n", {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (req.method !== "POST") return fel(405, "Bara POST");
  const s = await hämtaInställningar(env.DB);
  const server = new McpServer(
    { name: "snicksnack", title: s.name, version: "1.0.0" },
    {
      instructions:
        "Snack är inspelade samtal som transkriberats på en telefon (appen Snicksnack) och skickats hit. " +
        "Använd list_snacks eller search för att hitta dem och get_snack för att läsa ett. Ett snack pekas ut med target, sender och id.",
    },
  );
  registreraVerktyg(server, env, omfång, new URL(req.url).origin, req);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/** 429 som JSON-RPC-fel med Retry-After. */
function mcpFörMånga(text: string): Response {
  return json({ jsonrpc: "2.0", error: { code: -32029, message: text }, id: null }, 429, { "Retry-After": String(väntetid("mcp")) });
}

/** Vem anropet kommer från, för revisionsloggen. */
export function aktörFör(o: Omfång): string {
  return o.klient ? `oauth:${o.nyckel}` : `agent:${o.nyckel}`;
}

// ---------- Verktygen ----------

type Svar = { content: { type: "text"; text: string }[]; isError?: boolean };
const svar = (data: unknown): Svar => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const felsvar = (text: string): Svar => ({ content: [{ type: "text", text }], isError: true });

const tagglista = (v: string | null) => {
  try {
    const t = JSON.parse(v ?? "[]");
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
};

/** Villkor och parametrar för omfånget (avsändarnyckel = bara egna snack). */
function omfångsvillkor(o: Omfång, kolumn = "s.sender_id"): { sql: string; param: string[] } {
  return o.ägare ? { sql: "1 = 1", param: [] } : { sql: `${kolumn} = ?`, param: [o.avsändare] };
}

function synlig(o: Omfång, sender: string): boolean {
  return o.ägare || o.avsändare === sender;
}

const ref = {
  target: z.string().describe("The snack's target id (from list_snacks or search)."),
  sender: z.string().describe("The snack's sender id."),
  id: z.string().describe("The snack id."),
};

function registreraVerktyg(server: McpServer, env: Env, o: Omfång, origin: string, req: Request) {
  const db = env.DB;

  server.registerTool(
    "list_snacks",
    {
      title: "List snacks",
      description:
        "List received snacks (recorded and transcribed conversations), newest first. Filter by target, sender, " +
        "date range (YYYY-MM-DD, on recorded_at), tag, or a free-text query. Returns title, id, recorded_at, " +
        "duration (seconds), target, sender, tags and word count.",
      inputSchema: {
        target: z.string().optional().describe("Only this target id."),
        sender: z.string().optional().describe("Only this sender id."),
        from: z.string().optional().describe("Recorded on or after this date, YYYY-MM-DD."),
        to: z.string().optional().describe("Recorded on or before this date, YYYY-MM-DD."),
        tag: z.string().optional().describe("Only snacks with this tag."),
        query: z.string().optional().describe("Full-text filter on title, text, note and summaries."),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const villkor = [omfångsvillkor(o)];
      const lägg = (sql: string, ...param: string[]) => villkor.push({ sql, param });
      if (a.target) lägg("s.target_id = ?", a.target);
      if (a.sender) lägg("s.sender_id = ?", a.sender);
      if (a.from) lägg("substr(COALESCE(s.recorded_at, s.received_at), 1, 10) >= ?", a.from);
      if (a.to) lägg("substr(COALESCE(s.recorded_at, s.received_at), 1, 10) <= ?", a.to);
      if (a.tag) lägg("EXISTS (SELECT 1 FROM json_each(s.tags) WHERE lower(json_each.value) = lower(?))", a.tag);
      if (a.query) {
        const f = ftsFråga(a.query);
        if (!f) return svar({ snacks: [], total: 0 });
        lägg(
          `EXISTS (SELECT 1 FROM snacks_fts WHERE snacks_fts MATCH ? AND snacks_fts.target_id = s.target_id
             AND snacks_fts.sender_id = s.sender_id AND snacks_fts.snack_id = s.snack_id)`,
          f,
        );
      }
      const where = villkor.map((v) => `(${v.sql})`).join(" AND ");
      const param = villkor.flatMap((v) => v.param);
      const [rader, antal] = await db.batch([
        db
          .prepare(
            `SELECT s.target_id, s.sender_id, s.snack_id, s.title, s.recorded_at, s.duration, s.tags, s.word_count,
                    t.name AS target_name, se.name AS sender_name
             FROM snacks s LEFT JOIN targets t ON t.id = s.target_id LEFT JOIN senders se ON se.id = s.sender_id
             WHERE ${where} ORDER BY COALESCE(s.recorded_at, s.received_at) DESC LIMIT ? OFFSET ?`,
          )
          .bind(...param, a.limit, a.offset),
        db.prepare(`SELECT COUNT(*) AS n FROM snacks s WHERE ${where}`).bind(...param),
      ]);
      const r = rader.results as Record<string, any>[];
      return svar({
        total: (antal.results[0] as { n: number }).n,
        offset: a.offset,
        snacks: r.map((x) => ({
          target: x.target_id,
          sender: x.sender_id,
          id: x.snack_id,
          title: x.title,
          recorded_at: x.recorded_at,
          duration: x.duration,
          target_name: x.target_name,
          sender_name: x.sender_name,
          tags: tagglista(x.tags),
          words: x.word_count,
        })),
      });
    },
  );

  server.registerTool(
    "get_snack",
    {
      title: "Get a snack",
      description:
        "Read one snack: metadata, tags, and by default the transcript text with speaker prefixes at speaker changes " +
        '("[Anna, 1:23]: …"), the user\'s note and the app\'s summaries. Word-level timings only when include has "words".',
      inputSchema: {
        ...ref,
        include: z
          .array(z.enum(["text", "summaries", "note", "words"]))
          .optional()
          .describe('Parts to include. Default ["text", "summaries", "note"].'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      if (!synlig(o, a.sender)) return felsvar("Snacket finns inte.");
      const rad = await db
        .prepare(
          `SELECT s.*, t.name AS target_name, se.name AS sender_name FROM snacks s
           LEFT JOIN targets t ON t.id = s.target_id LEFT JOIN senders se ON se.id = s.sender_id
           WHERE s.target_id = ? AND s.sender_id = ? AND s.snack_id = ?`,
        )
        .bind(a.target, a.sender, a.id)
        .first<Record<string, any>>();
      if (!rad) return felsvar("Snacket finns inte.");
      const delar = new Set(a.include ?? ["text", "summaries", "note"]);
      const prefix = `${a.target}/${a.sender}/${a.id}/`;
      const obj = await env.FILER.get(prefix + "transcript.json");
      let t: Transkript & { summaries?: unknown; speakers_hidden?: unknown } = {};
      if (obj) {
        try {
          t = await obj.json();
        } catch {
          // trasig JSON: bara metadata
        }
      }
      const ut: Record<string, unknown> = {
        target: rad.target_id,
        sender: rad.sender_id,
        id: rad.snack_id,
        title: rad.title,
        recorded_at: rad.recorded_at,
        duration: rad.duration,
        language: rad.language,
        target_name: rad.target_name,
        sender_name: rad.sender_name,
        tags: tagglista(rad.tags),
        words_count: rad.word_count,
        has_audio: tagglista(rad.files).some((f: string) => f.startsWith("audio.")),
      };
      if (t.speakers && typeof t.speakers === "object") {
        ut.speakers = Object.fromEntries(Object.keys(t.speakers).map((k) => [k, talarnamn(t, Number(k))]));
      }
      if (delar.has("note")) ut.note = typeof t.note === "string" ? t.note : null;
      if (delar.has("text")) {
        let text = obj ? transkriptText(t, "chatt") : "";
        if (!text) {
          const md = await env.FILER.get(prefix + "text.md");
          text = md ? await md.text() : "";
        }
        ut.text = text;
      }
      if (delar.has("summaries")) ut.summaries = Array.isArray(t.summaries) ? t.summaries : [];
      if (delar.has("words")) ut.words = Array.isArray(t.words) ? t.words : [];
      return svar(ut);
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search snacks",
      description:
        "Full-text search in titles, transcript text, notes and summaries. Words are matched as prefixes and all " +
        "must occur. Returns hits with a snippet (matches marked with « ») and the snack reference (target, sender, id).",
      inputSchema: {
        query: z.string().min(1).describe("Search words."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const f = ftsFråga(a.query);
      if (!f) return svar({ hits: [] });
      const v = omfångsvillkor(o, "snacks_fts.sender_id");
      const { results } = await db
        .prepare(
          `SELECT snacks_fts.target_id, snacks_fts.sender_id, snacks_fts.snack_id, s.title, s.recorded_at, s.duration,
                  snippet(snacks_fts, -1, '«', '»', ' … ', 16) AS snippet
           FROM snacks_fts JOIN snacks s ON s.target_id = snacks_fts.target_id AND s.sender_id = snacks_fts.sender_id
             AND s.snack_id = snacks_fts.snack_id
           WHERE snacks_fts MATCH ? AND ${v.sql} ORDER BY bm25(snacks_fts) LIMIT ?`,
        )
        .bind(f, ...v.param, a.limit)
        .all<Record<string, any>>();
      return svar({
        hits: results.map((r) => ({
          target: r.target_id,
          sender: r.sender_id,
          id: r.snack_id,
          title: r.title,
          recorded_at: r.recorded_at,
          duration: r.duration,
          snippet: r.snippet,
        })),
      });
    },
  );

  server.registerTool(
    "get_audio_url",
    {
      title: "Get audio URL",
      description: "A signed link to the snack's audio (m4a with Apple Lossless, or wav), valid for one hour. Supports Range requests.",
      inputSchema: ref,
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      if (!synlig(o, a.sender)) return felsvar("Snacket finns inte.");
      const finns = await db
        .prepare("SELECT 1 FROM snacks WHERE target_id = ? AND sender_id = ? AND snack_id = ?")
        .bind(a.target, a.sender, a.id)
        .first();
      if (!finns) return felsvar("Snacket finns inte.");
      if (!env.KEY_SECRET) return felsvar("Servern saknar KEY_SECRET och kan inte signera länkar.");
      const prefix = `${a.target}/${a.sender}/${a.id}/`;
      const lista = await env.FILER.list({ prefix: prefix + "audio." });
      const ljud = lista.objects[0];
      if (!ljud) return felsvar("Snacket har inget ljud på servern.");
      const utgår = Math.floor(Date.now() / 1000) + LJUDLÄNK_SEKUNDER;
      const token = await signera(env.KEY_SECRET, `${utgår}\n${ljud.key}`);
      await revisionslogg(env, req, "ljudlank.skapad", `${prefix.slice(0, -1)}${o.klient ? ` till ${o.klient}` : ""}, gäller en timme`, aktörFör(o));
      return svar({
        url: `${origin}/ljud/${token}`,
        expires_at: new Date(utgår * 1000).toISOString(),
        content_type: ljud.key.endsWith(".wav") ? "audio/wav" : "audio/mp4",
        bytes: ljud.size,
      });
    },
  );

  server.registerTool(
    "list_targets",
    {
      title: "List targets",
      description: o.ägare
        ? "List the targets (customers, projects, folders the senders choose between) and the senders, with snack counts."
        : "List the targets this key's sender can send to, with snack counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const mål = o.ägare
        ? await db
            .prepare(
              `SELECT t.id, t.name, t.grp, (SELECT COUNT(*) FROM snacks s WHERE s.target_id = t.id) AS snacks
               FROM targets t ORDER BY t.grp IS NOT NULL, t.grp, t.name`,
            )
            .all<Record<string, any>>()
        : await db
            .prepare(
              `SELECT t.id, t.name, t.grp, (SELECT COUNT(*) FROM snacks s WHERE s.target_id = t.id AND s.sender_id = ?1) AS snacks
               FROM targets t JOIN sender_targets st ON st.target_id = t.id WHERE st.sender_id = ?1
               ORDER BY t.grp IS NOT NULL, t.grp, t.name`,
            )
            .bind(o.avsändare)
            .all<Record<string, any>>();
      const ut: Record<string, unknown> = {
        targets: mål.results.map((m) => ({ id: m.id, name: m.name, group: m.grp, snacks: m.snacks })),
      };
      if (o.ägare) {
        const { results } = await db
          .prepare(
            `SELECT se.id, se.name, se.key_hash IS NULL AS revoked, (SELECT COUNT(*) FROM snacks s WHERE s.sender_id = se.id) AS snacks
             FROM senders se ORDER BY se.name`,
          )
          .all<Record<string, any>>();
        ut.senders = results.map((x) => ({ id: x.id, name: x.name, revoked: !!x.revoked, snacks: x.snacks }));
      }
      return svar(ut);
    },
  );
}

// ---------- Den signerade ljudlänken ----------

export async function ljud(req: Request, env: Env, token: string): Promise<Response> {
  if (!env.KEY_SECRET) return fel(404, "Finns inte");
  const text = await verifiera(env.KEY_SECRET, token);
  const m = text && /^(\d+)\n(.+)$/s.exec(text);
  if (!m) return fel(404, "Ogiltig länk");
  if (Number(m[1]) < Date.now() / 1000) return fel(410, "Länken har gått ut");
  const obj = await env.FILER.get(m[2], { range: req.headers, onlyIf: req.headers });
  if (!obj) return fel(404, "Ljudet finns inte längre");
  const huvuden = new Headers({ "Cache-Control": "private, max-age=3600", ETag: obj.httpEtag, "Accept-Ranges": "bytes", ...FILHUVUDEN });
  obj.writeHttpMetadata(huvuden);
  if (!("body" in obj)) return new Response(null, { status: 304, headers: huvuden });
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (req.headers.has("Range") && r && r.offset !== undefined) {
    const längd = r.length ?? obj.size - r.offset;
    huvuden.set("Content-Range", `bytes ${r.offset}-${r.offset + längd - 1}/${obj.size}`);
    huvuden.set("Content-Length", String(längd));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers: huvuden });
  }
  huvuden.set("Content-Length", String(obj.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { headers: huvuden });
}

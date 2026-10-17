// Sökindexet (FTS5 i D1): titel, text, anteckning och sammanfattningar per snack.

import { transkriptText, type Transkript } from "./ai/transkript";

export interface SnackRef {
  target: string;
  sender: string;
  id: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function antalOrd(t: Transkript): number {
  if (Array.isArray(t.words) && t.words.length) return t.words.length;
  return str(t.text).split(/\s+/).filter(Boolean).length;
}

function sammanfattningstext(t: Transkript & { summaries?: unknown }): string {
  if (!Array.isArray(t.summaries)) return "";
  const rader: string[] = [];
  for (const s of t.summaries as { items?: { section?: unknown; text?: unknown }[] }[]) {
    for (const i of s?.items ?? []) if (str(i?.text)) rader.push(`${str(i.section)}: ${str(i.text)}`);
  }
  return rader.join("\n");
}

/** Lägger in (eller ersätter) snacket i sökindexet och sparar antalet ord. */
export async function indexera(db: D1Database, ref: SnackRef, t: Transkript): Promise<void> {
  const text = str(t.text).trim() || transkriptText({ ...t, speakers: {} }, "chatt");
  await db.batch([
    db.prepare("DELETE FROM snacks_fts WHERE target_id = ? AND sender_id = ? AND snack_id = ?").bind(ref.target, ref.sender, ref.id),
    db
      .prepare("INSERT INTO snacks_fts (target_id, sender_id, snack_id, title, text, note, summaries) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ref.target, ref.sender, ref.id, str(t.title), text, str(t.note), sammanfattningstext(t)),
    db
      .prepare("UPDATE snacks SET word_count = ? WHERE target_id = ? AND sender_id = ? AND snack_id = ?")
      .bind(antalOrd(t), ref.target, ref.sender, ref.id),
  ]);
}

export async function tabortUrIndex(db: D1Database, ref: SnackRef): Promise<void> {
  await db.prepare("DELETE FROM snacks_fts WHERE target_id = ? AND sender_id = ? AND snack_id = ?").bind(ref.target, ref.sender, ref.id).run();
}

/** Bygger om indexet för alla snack från transcript.json i R2. Returnerar antalet indexerade. */
export async function byggOmIndex(env: Env): Promise<{ snack: number; indexerade: number }> {
  const { results } = await env.DB.prepare("SELECT target_id, sender_id, snack_id FROM snacks").all<{
    target_id: string;
    sender_id: string;
    snack_id: string;
  }>();
  let indexerade = 0;
  for (const r of results) {
    const obj = await env.FILER.get(`${r.target_id}/${r.sender_id}/${r.snack_id}/transcript.json`);
    if (!obj) continue;
    try {
      const t = (await obj.json()) as Transkript;
      await indexera(env.DB, { target: r.target_id, sender: r.sender_id, id: r.snack_id }, t);
      indexerade++;
    } catch (e) {
      console.error("indexera", r, e);
    }
  }
  return { snack: results.length, indexerade };
}

/** Gör användarens sökord till en säker FTS5-fråga: varje ord i citattecken, med prefix-sök. */
export function ftsFråga(q: string): string | null {
  const ord = q
    .split(/\s+/)
    .map((o) => o.replace(/["*^():]/g, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  return ord.length ? ord.map((o) => `"${o}"*`).join(" ") : null;
}

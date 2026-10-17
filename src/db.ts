// Åtkomst till D1: inställningar, mål, avsändare och indexet över snack.

import { sha256Hex } from "./krypto";

export const DELAR = ["audio", "transcript", "text"] as const;
export type Del = (typeof DELAR)[number];

export interface Inställningar {
  name: string;
  color: string | null;
  accepts: Del[];
  /** Tidpunkt då loggan laddades upp, eller null om det inte finns någon. */
  icon: string | null;
  /** Fri fråga i chatten (utan prompt): leverantör, modell och systemtext. Tomt = första chattprompten. */
  chatProvider: string | null;
  chatModel: string | null;
  chatSystem: string;
}

export const STANDARDNAMN = "Snicksnack-mottagare";

export async function hämtaInställningar(db: D1Database): Promise<Inställningar> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  let accepts: Del[] = [...DELAR];
  try {
    const a = JSON.parse(m.get("accepts") ?? "null");
    if (Array.isArray(a)) accepts = a.filter((d): d is Del => (DELAR as readonly string[]).includes(d));
  } catch {
    // trasigt värde: alla delar
  }
  return {
    name: m.get("name") || STANDARDNAMN,
    color: m.get("color") || null,
    accepts,
    icon: m.get("icon") || null,
    chatProvider: m.get("chat_provider") || null,
    chatModel: m.get("chat_model") || null,
    chatSystem: m.get("chat_system") || "",
  };
}

export async function sättInställning(db: D1Database, nyckel: string, värde: string | null): Promise<void> {
  if (värde === null) await db.prepare("DELETE FROM settings WHERE key = ?").bind(nyckel).run();
  else
    await db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(nyckel, värde)
      .run();
}

export interface Mål {
  id: string;
  name: string;
  grp: string | null;
}

export async function allaMål(db: D1Database): Promise<Mål[]> {
  const { results } = await db.prepare("SELECT id, name, grp FROM targets ORDER BY grp IS NOT NULL, grp, name").all<Mål>();
  return results;
}

export async function målFörAvsändare(db: D1Database, avsändare: string): Promise<Mål[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.grp FROM targets t JOIN sender_targets st ON st.target_id = t.id
       WHERE st.sender_id = ? ORDER BY t.grp IS NOT NULL, t.grp, t.name`,
    )
    .bind(avsändare)
    .all<Mål>();
  return results;
}

/** Målet om det finns och avsändaren har tilldelats det. */
export async function tilldelatMål(db: D1Database, avsändare: string, mål: string): Promise<Mål | null> {
  return db
    .prepare(
      `SELECT t.id, t.name, t.grp FROM targets t JOIN sender_targets st ON st.target_id = t.id
       WHERE t.id = ? AND st.sender_id = ?`,
    )
    .bind(mål, avsändare)
    .first<Mål>();
}

export interface Avsändare {
  id: string;
  name: string;
  key_hint: string | null;
  created_at: string;
  revoked_at: string | null;
}

export async function avsändareFrånNyckel(db: D1Database, nyckel: string): Promise<Avsändare | null> {
  if (!nyckel) return null;
  return db
    .prepare("SELECT id, name, key_hint, created_at, revoked_at FROM senders WHERE key_hash = ?")
    .bind(await sha256Hex(nyckel))
    .first<Avsändare>();
}

export async function allaAvsändare(db: D1Database): Promise<(Avsändare & { targets: string[] })[]> {
  const [a, t] = await db.batch([
    db.prepare("SELECT id, name, key_hint, created_at, revoked_at FROM senders ORDER BY name"),
    db.prepare("SELECT sender_id, target_id FROM sender_targets"),
  ]);
  const tilldelade = new Map<string, string[]>();
  for (const r of t.results as { sender_id: string; target_id: string }[]) {
    tilldelade.set(r.sender_id, [...(tilldelade.get(r.sender_id) ?? []), r.target_id]);
  }
  return (a.results as Avsändare[]).map((x) => ({ ...x, targets: tilldelade.get(x.id) ?? [] }));
}

export function nu(): string {
  return new Date().toISOString();
}

/** URL-säker slug av ett namn (å, ä, ö blir a, a, o). */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "avsandare"
  );
}

/** Mål-id: URL-säkert, börjar inte med "_" (reserverat för _config i R2). */
export const MÅL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SnackRad {
  target_id: string;
  sender_id: string;
  snack_id: string;
  title: string | null;
  recorded_at: string | null;
  duration: number | null;
  language: string | null;
  tags: string;
  files: string;
  bytes: number;
  received_at: string;
  updated_at: string;
  sends: number;
  target_name?: string | null;
  sender_name?: string | null;
}

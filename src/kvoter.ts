// Kvoter per avsändare (AI-anrop per dygn, tokens per 30 dagar, lagring) och en global AI-budget. Ägaren ställer in
// dem i admin: standarden under Inställningar, undantag på avsändaren. Förbrukningen räknas ur usage (AI) och
// snacks.bytes (lagring). Kontrollen görs före anropet, så parallella anrop kan gå något över taket.

import { hämtaInställningar, type Inställningar, type Kvoter } from "./db";

export const MB = 1024 * 1024;

export interface Förbrukning {
  /** AI-anrop i dag (UTC). */
  anropIdag: number;
  /** Tokens (in och ut) de senaste 30 dagarna, i dag inräknad. */
  tokens30: number;
  /** Byte i R2 för avsändarens snack. */
  bytes: number;
}

const idag = () => new Date().toISOString().slice(0, 10);
const trettioDagar = () => new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);

/** Avsändarens kvoter: egna värden, annars standarden. */
export async function kvoterFör(db: D1Database, avsändare: string, s: Inställningar): Promise<Kvoter> {
  const r = await db
    .prepare("SELECT quota_ai_requests_day AS a, quota_ai_tokens_30d AS t, quota_storage_mb AS l FROM senders WHERE id = ?")
    .bind(avsändare)
    .first<{ a: number | null; t: number | null; l: number | null }>();
  return {
    aiAnropDag: r?.a ?? s.kvoter.aiAnropDag,
    aiTokens30: r?.t ?? s.kvoter.aiTokens30,
    lagringMB: r?.l ?? s.kvoter.lagringMB,
  };
}

export async function förbrukning(db: D1Database, avsändare: string): Promise<Förbrukning> {
  const r = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(requests), 0) FROM usage WHERE sender_id = ?1 AND day = ?2) AS anrop,
              (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM usage WHERE sender_id = ?1 AND day >= ?3) AS tokens,
              (SELECT COALESCE(SUM(bytes), 0) FROM snacks WHERE sender_id = ?1) AS bytes`,
    )
    .bind(avsändare, idag(), trettioDagar())
    .first<{ anrop: number; tokens: number; bytes: number }>();
  return { anropIdag: r?.anrop ?? 0, tokens30: r?.tokens ?? 0, bytes: r?.bytes ?? 0 };
}

/** Förbrukning per avsändare för listan i admin. */
export async function allFörbrukning(db: D1Database): Promise<Map<string, Förbrukning>> {
  const [ai, lagring] = await db.batch<{ id: string; anrop?: number; tokens?: number; bytes?: number }>([
    db
      .prepare(
        `SELECT sender_id AS id, SUM(CASE WHEN day = ?1 THEN requests ELSE 0 END) AS anrop,
                SUM(input_tokens + output_tokens) AS tokens FROM usage WHERE day >= ?2 GROUP BY sender_id`,
      )
      .bind(idag(), trettioDagar()),
    db.prepare("SELECT sender_id AS id, SUM(bytes) AS bytes FROM snacks GROUP BY sender_id"),
  ]);
  const ut = new Map<string, Förbrukning>();
  const rad = (id: string) => ut.get(id) ?? ut.set(id, { anropIdag: 0, tokens30: 0, bytes: 0 }).get(id)!;
  for (const r of ai.results) Object.assign(rad(r.id), { anropIdag: r.anrop ?? 0, tokens30: r.tokens ?? 0 });
  for (const r of lagring.results) rad(r.id).bytes = r.bytes ?? 0;
  return ut;
}

/** Tokens de senaste 30 dagarna för alla avsändare. */
export async function totalaTokens(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM usage WHERE day >= ?")
    .bind(trettioDagar())
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export const tal = (n: number) => n.toLocaleString("sv-SE");
export const megabyte = (b: number) => (b / MB).toLocaleString("sv-SE", { maximumFractionDigits: b < 10 * MB ? 1 : 0 });

/** Texten till appen om ett AI-anrop inte får göras, annars null. */
export async function aiStopp(db: D1Database, avsändare: { id: string; name: string }): Promise<string | null> {
  const s = await hämtaInställningar(db);
  const [k, f, totalt] = await Promise.all([
    kvoterFör(db, avsändare.id, s),
    förbrukning(db, avsändare.id),
    s.aiBudget !== null ? totalaTokens(db) : Promise.resolve(0),
  ]);
  if (s.aiBudget !== null && totalt >= s.aiBudget) {
    return `Mottagarens AI-budget för 30 dagar är slut (${tal(s.aiBudget)} tokens). Be den som driver ${s.name} att höja den.`;
  }
  if (k.aiAnropDag !== null && f.anropIdag >= k.aiAnropDag) {
    return k.aiAnropDag === 0
      ? `${avsändare.name} har ingen AI hos ${s.name}.`
      : `Dagens AI-anrop är slut (${tal(k.aiAnropDag)} per dygn). Försök igen i morgon.`;
  }
  if (k.aiTokens30 !== null && f.tokens30 >= k.aiTokens30) {
    return `AI-kvoten för 30 dagar är slut (${tal(k.aiTokens30)} tokens). Be den som driver ${s.name} om mer.`;
  }
  return null;
}

/** Texten till appen om ett snack inte får plats, annars null. nya = byte som skickas, gamla = byte det ersätter. */
export async function lagringStopp(db: D1Database, avsändare: string, nya: number, gamla: number): Promise<string | null> {
  const s = await hämtaInställningar(db);
  const k = await kvoterFör(db, avsändare, s);
  if (k.lagringMB === null) return null;
  const f = await förbrukning(db, avsändare);
  if (f.bytes - gamla + nya <= k.lagringMB * MB) return null;
  return `Lagringen hos ${s.name} är full (${tal(k.lagringMB)} MB, ${megabyte(f.bytes)} MB används). Be den som driver mottagaren om mer utrymme, eller skicka utan ljud.`;
}

/** Förbrukningen mot kvoterna som text: "AI i dag 3 av 50 anrop · 30 dagar 12 000 tokens · lagring 12 av 500 MB". */
export function kvottext(k: Kvoter, f: Förbrukning): string {
  const av = (n: string, tak: number | null, enhet: string) => (tak === null ? `${n} ${enhet}` : `${n} av ${tal(tak)} ${enhet}`);
  return [
    `AI i dag ${av(tal(f.anropIdag), k.aiAnropDag, "anrop")}`,
    `30 dagar ${av(tal(f.tokens30), k.aiTokens30, "tokens")}`,
    `lagring ${av(megabyte(f.bytes), k.lagringMB, "MB")}`,
  ].join(" · ");
}

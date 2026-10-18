// Revisionsloggen (tabellen audit, migration 0005): inloggningar, nycklar, OAuth, inställningar, ljudlänkar och
// borttagna snack. Inget innehåll, bara vem, vad, när och varifrån. Visas under Logg i admin.

import { nu } from "./db";

export const SPARA_DAGAR = 90;

/** Händelserna och hur de visas i admin. */
export const HÄNDELSER = {
  "inloggning.ok": "Inloggning i admin",
  "inloggning.fel": "Fel adminlösenord",
  "inloggning.sparr": "Inloggningen spärrad",
  "oauth.godkand": "Klient godkänd (OAuth)",
  "oauth.fel": "Misslyckad OAuth-inloggning",
  "oauth.skapad": "OAuth-inloggning skapad",
  "oauth.aterkallad": "OAuth-inloggning återkallad",
  "avsandare.skapad": "Avsändare skapad",
  "avsandare.andrad": "Avsändare ändrad",
  "avsandare.ny_nyckel": "Ny avsändarnyckel",
  "avsandare.sparrad": "Avsändare spärrad",
  "avsandare.borttagen": "Avsändare borttagen",
  "avsandare.ny_sida": "Ny länk till personliga sidan",
  "agentnyckel.skapad": "Agentnyckel skapad",
  "agentnyckel.sparrad": "Agentnyckel spärrad",
  "installningar.andrade": "Inställningar ändrade",
  "leverantor.andrad": "Leverantör ändrad",
  "prompt.andrad": "Prompt ändrad",
  "ljudlank.skapad": "Ljudlänk skapad",
  "snack.raderat": "Snack borttaget",
} as const;

export type Händelse = keyof typeof HÄNDELSER;

export interface Loggrad {
  id: number;
  at: string;
  event: string;
  actor: string;
  ip: string | null;
  ua: string | null;
  detail: string;
}

/** Webbläsare eller klient i kort form: "Safari på iPhone", annars de första 80 tecknen. */
export function kortUa(ua: string | null): string | null {
  if (!ua) return null;
  const system = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const program = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  if (program && system) return `${program} på ${system}`;
  return ua.slice(0, 80);
}

/** Skriver en rad. Fel här stoppar aldrig det som loggas. */
export async function revisionslogg(env: Env, req: Request | null, händelse: Händelse, detalj = "", aktör = "ägaren"): Promise<void> {
  try {
    const ip = req?.headers.get("CF-Connecting-IP") ?? null;
    const ua = kortUa(req?.headers.get("User-Agent") ?? null);
    await env.DB.prepare("INSERT INTO audit (at, event, actor, ip, ua, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(nu(), händelse, aktör, ip, ua, detalj.slice(0, 500))
      .run();
    // Gamla rader rensas då och då vid skrivning, och varje natt av städningen.
    if (Math.random() < 0.02) await rensaLogg(env.DB);
  } catch (e) {
    console.error("revisionslogg:", händelse, e);
  }
}

export async function rensaLogg(db: D1Database, dagar = SPARA_DAGAR): Promise<number> {
  const gräns = new Date(Date.now() - dagar * 86400_000).toISOString();
  const r = await db.prepare("DELETE FROM audit WHERE at < ?").bind(gräns).run();
  return r.meta.changes ?? 0;
}

export async function senasteLogg(db: D1Database, antal = 200): Promise<Loggrad[]> {
  return (await db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").bind(antal).all<Loggrad>()).results;
}

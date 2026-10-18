// Spärren efter misslyckade adminlösenord (admin och ägarens väg i /authorize). Räknas i D1, så den gäller över
// alla Cloudflare-platser, till skillnad från rate limiting (ratelimit.ts) som är per plats. Nås gränsen per IP
// (LOGIN_LOCK_IP) eller för alla tillsammans (LOGIN_LOCK_GLOBAL) den senaste timmen svarar inloggningen 429 i en
// timme, också med rätt lösenord. En admin-session som redan finns påverkas inte.

import { nu } from "./db";
import { revisionslogg } from "./revision";

export const SPÄRR_SEKUNDER = 3600;
const TIMME = 3600_000;

const gränser = (env: Env) => ({
  ip: Number(env.LOGIN_LOCK_IP) || 20,
  alla: Number(env.LOGIN_LOCK_GLOBAL) || 100,
});

/** Sekunder kvar av en spärr som gäller adressen (eller alla), annars null. */
export async function spärrad(env: Env, ip: string): Promise<number | null> {
  const rad = await env.DB.prepare("SELECT MAX(until) AS until FROM login_locks WHERE scope IN (?, 'alla') AND until > ?")
    .bind(`ip:${ip}`, nu())
    .first<{ until: string | null }>();
  if (!rad?.until) return null;
  return Math.max(1, Math.ceil((Date.parse(rad.until) - Date.now()) / 1000));
}

/** Ett misslyckat försök. Spärrar och loggar när gränsen nås. */
export async function misslyckad(env: Env, req: Request, ip: string, var_: string): Promise<void> {
  const tid = nu();
  const sedan = new Date(Date.now() - TIMME).toISOString();
  const [, antal] = await env.DB.batch<{ ip: number; alla: number }>([
    env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(ip, tid),
    env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM login_failures WHERE ip = ?1 AND at > ?2) AS ip, (SELECT COUNT(*) FROM login_failures WHERE at > ?2) AS alla",
    ).bind(ip, sedan),
  ]);
  const n = antal.results[0] ?? { ip: 0, alla: 0 };
  const g = gränser(env);
  const till = new Date(Date.now() + SPÄRR_SEKUNDER * 1000).toISOString();
  const spärra = async (scope: string, text: string) => {
    await env.DB.prepare("INSERT INTO login_locks (scope, until) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET until = excluded.until")
      .bind(scope, till)
      .run();
    await revisionslogg(env, req, "inloggning.sparr", text, "okänd");
  };
  if (n.ip >= g.ip) await spärra(`ip:${ip}`, `${n.ip} fel lösenord från ${ip} senaste timmen (${var_}). Spärrad i en timme.`);
  if (n.alla >= g.alla) await spärra("alla", `${n.alla} fel lösenord från alla adresser senaste timmen (${var_}). All inloggning med lösenord spärrad i en timme.`);
}

/** Ett lyckat försök: adressens räknare nollställs. */
export async function lyckad(env: Env, ip: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
}

/** Städningen: försök äldre än ett dygn och spärrar som gått ut. */
export async function rensaSpärrar(db: D1Database): Promise<number> {
  const [a, b] = await db.batch([
    db.prepare("DELETE FROM login_failures WHERE at < ?").bind(new Date(Date.now() - 24 * TIMME).toISOString()),
    db.prepare("DELETE FROM login_locks WHERE until < ?").bind(nu()),
  ]);
  return (a.meta.changes ?? 0) + (b.meta.changes ?? 0);
}

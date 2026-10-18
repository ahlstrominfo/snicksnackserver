// Den nattliga städningen (cron i wrangler.jsonc, "17 3 * * *"): OAuth-klienter som aldrig fick en inloggning,
// utgångna koder och inloggningar, gamla rader i revisionsloggen, inloggningsförsök och spärrar som gått ut, och
// länkar till personliga sidor som fortfarande ligger i klartext.

import { hashaGamlaSidtokens } from "./agenter";
import { nu } from "./db";
import { rensaLogg } from "./revision";
import { rensaSpärrar } from "./sparr";

/** Hur länge en återkallad eller utgången OAuth-inloggning ligger kvar (för listorna och felsökning). */
const GRANT_DAGAR = 7;

export interface Städat {
  klienter: number;
  koder: number;
  inloggningar: number;
  logg: number;
  spärrar: number;
  sidlänkar: number;
}

export async function städa(env: Env): Promise<Städat> {
  const db = env.DB;
  const tid = nu();
  const dygn = new Date(Date.now() - 86400_000).toISOString();
  const vecka = new Date(Date.now() - GRANT_DAGAR * 86400_000).toISOString();
  const [koder, inloggningar, klienter] = await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(tid),
    db.prepare(
      `DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?1)
         OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < ?2)`,
    ).bind(vecka, tid),
    // Klienter äldre än ett dygn utan inloggning och utan kod som väntar (registrerade men aldrig använda).
    db.prepare(
      `DELETE FROM oauth_clients WHERE created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
         AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.id)`,
    ).bind(dygn),
  ]);
  const ut: Städat = {
    klienter: klienter.meta.changes ?? 0,
    koder: koder.meta.changes ?? 0,
    inloggningar: inloggningar.meta.changes ?? 0,
    logg: await rensaLogg(db),
    spärrar: await rensaSpärrar(db),
    sidlänkar: await hashaGamlaSidtokens(db),
  };
  console.log(JSON.stringify({ händelse: "städning", ...ut }));
  return ut;
}

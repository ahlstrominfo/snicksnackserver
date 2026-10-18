// Agentnycklar för MCP: ägarens (ser allt) och avsändarnas (ser bara sina egna snack).

import { nu } from "./db";
import { base64url, sha256Hex, slumptoken } from "./krypto";

export const AGENTPREFIX = "ssk_agent_";

export interface Agentnyckel {
  id: string;
  owner: string;
  name: string;
  key_hint: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Omfånget för ett anrop: ägaren ser allt, en avsändare bara sina snack. nyckel är agentnyckelns eller
 * OAuth-inloggningens id; klient är klientens namn för OAuth. */
export type Omfång =
  | { ägare: true; nyckel: string; klient?: string }
  | { ägare: false; avsändare: string; nyckel: string; klient?: string };

export function nyAgentnyckel(): string {
  return AGENTPREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Skapar en nyckel och returnerar den i klartext (visas en gång). */
export async function skapaAgentnyckel(db: D1Database, owner: string, namn: string): Promise<string> {
  const nyckel = nyAgentnyckel();
  await db
    .prepare("INSERT INTO agent_keys (id, owner, name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(slumptoken(9), owner, namn.slice(0, 80), await sha256Hex(nyckel), nyckel.slice(-4), nu())
    .run();
  return nyckel;
}

export async function agentnycklar(db: D1Database, owner?: string): Promise<Agentnyckel[]> {
  const sql = "SELECT id, owner, name, key_hint, created_at, last_used_at, revoked_at FROM agent_keys";
  const q = owner
    ? db.prepare(`${sql} WHERE owner = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`).bind(owner)
    : db.prepare(`${sql} ORDER BY revoked_at IS NOT NULL, created_at DESC`);
  return (await q.all<Agentnyckel>()).results;
}

/** Spärrar en nyckel. Med owner bara om den hör till den ägaren. */
export async function spärraAgentnyckel(db: D1Database, id: string, owner?: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE agent_keys SET key_hash = NULL, revoked_at = ? WHERE id = ? AND revoked_at IS NULL${owner ? " AND owner = ?" : ""}`,
    )
    .bind(...(owner ? [nu(), id, owner] : [nu(), id]))
    .run();
  return r.meta.changes > 0;
}

/** Omfånget för en Bearer-nyckel, eller null. En spärrad avsändares agentnycklar slutar också fungera. */
export async function agentFrånAnrop(req: Request, env: Env, ctx: ExecutionContext): Promise<Omfång | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m || !m[1].startsWith(AGENTPREFIX)) return null;
  const rad = await env.DB.prepare(
    `SELECT a.id, a.owner, s.key_hash AS sender_key FROM agent_keys a LEFT JOIN senders s ON s.id = a.owner
     WHERE a.key_hash = ?`,
  )
    .bind(await sha256Hex(m[1]))
    .first<{ id: string; owner: string; sender_key: string | null }>();
  if (!rad) return null;
  if (rad.owner !== "owner" && !rad.sender_key) return null;
  ctx.waitUntil(
    env.DB.prepare("UPDATE agent_keys SET last_used_at = ? WHERE id = ?").bind(nu(), rad.id).run().catch((e) => console.error(e)),
  );
  return rad.owner === "owner" ? { ägare: true, nyckel: rad.id } : { ägare: false, avsändare: rad.owner, nyckel: rad.id };
}

// ---------- Länken till den personliga sidan (/min/<token>) ----------
// Sparas bara som SHA-256 (page_hash), som nycklarna, och visas en gång när den skapas. Länkar från före
// migration 0005 låg i klartext i page_token; de hashas när de används, när ägaren öppnar Avsändare och av
// städningen, och fortsätter att fungera.

/** En ny länk (den gamla slutar gälla). Token i klartext, eller null om avsändaren inte finns. */
export async function bytSidtoken(db: D1Database, avsändare: string): Promise<string | null> {
  const token = slumptoken(24);
  const r = await db
    .prepare("UPDATE senders SET page_hash = ?, page_token = NULL, page_created_at = ? WHERE id = ?")
    .bind(await sha256Hex(token), nu(), avsändare)
    .run();
  return r.meta.changes ? token : null;
}

export interface Sidägare {
  id: string;
  name: string;
  key_hash: string | null;
}

/** Avsändaren som länken hör till (också spärrade; anroparen kontrollerar key_hash). */
export async function avsändareFrånSidtoken(db: D1Database, token: string): Promise<Sidägare | null> {
  if (!token || token.length > 128) return null;
  const hash = await sha256Hex(token);
  const rad = await db
    .prepare("SELECT id, name, key_hash, page_token FROM senders WHERE page_hash = ?1 OR page_token = ?2")
    .bind(hash, token)
    .first<Sidägare & { page_token: string | null }>();
  if (!rad) return null;
  if (rad.page_token) {
    await db.prepare("UPDATE senders SET page_hash = ?, page_token = NULL WHERE id = ? AND page_token = ?").bind(hash, rad.id, token).run();
  }
  return { id: rad.id, name: rad.name, key_hash: rad.key_hash };
}

/** Engångsmigreringen: hashar länkar som fortfarande ligger i klartext. Antal hashade. */
export async function hashaGamlaSidtokens(db: D1Database): Promise<number> {
  const { results } = await db.prepare("SELECT id, page_token FROM senders WHERE page_token IS NOT NULL").all<{ id: string; page_token: string }>();
  if (!results.length) return 0;
  await db.batch(
    await Promise.all(
      results.map(async (r) =>
        db
          .prepare("UPDATE senders SET page_hash = ?, page_token = NULL WHERE id = ? AND page_token = ?")
          .bind(await sha256Hex(r.page_token), r.id, r.page_token),
      ),
    ),
  );
  return results.length;
}

/** Instruktionerna för att koppla en agent (samma på ägarens och avsändarens sidor). */
export function mcpKommandon(origin: string, nyckel: string) {
  const adress = `${origin}/mcp`;
  return {
    adress,
    claudeCode: `claude mcp add --transport http snicksnack ${adress} --header "Authorization: Bearer ${nyckel}"`,
    json: JSON.stringify({ mcpServers: { snicksnack: { url: adress, headers: { Authorization: `Bearer ${nyckel}` } } } }, null, 2),
  };
}

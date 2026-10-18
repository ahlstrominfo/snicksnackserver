// Rate limiting: Cloudflares bindning för Workers (ratelimits i wrangler.jsonc) när den finns, annars en räknare i
// minnet per isolat med samma värden (lokalt och om bindningen saknas). Bindningen räknar per Cloudflare-plats och
// är ungefärlig: ett tak mot gissning och överbelastning, inte en exakt kvot. Fel i bindningen släpper igenom
// anropet hellre än att stoppa tjänsten.

export const GRÄNSER = {
  /** Adminlösenordet (admin och /authorize), per IP. */
  inloggning: { bindning: "RL_INLOGGNING", gräns: 5, period: 60 },
  /** OAuth-registrering, per IP. */
  register: { bindning: "RL_REGISTER", gräns: 10, period: 60 },
  /** OAuth /token, per IP. */
  token: { bindning: "RL_TOKEN", gräns: 30, period: 60 },
  /** Mottagning, per avsändare. */
  mottagning: { bindning: "RL_MOTTAGNING", gräns: 30, period: 60 },
  /** Ogiltiga nycklar, tokens och länkar, per IP. */
  gissning: { bindning: "RL_GISSNING", gräns: 20, period: 60 },
  /** summarize och chat, per avsändare. */
  ai: { bindning: "RL_AI", gräns: 10, period: 60 },
  /** MCP, per agentnyckel eller OAuth-inloggning. */
  mcp: { bindning: "RL_MCP", gräns: 60, period: 60 },
} as const;

export type Gräns = keyof typeof GRÄNSER;

interface Begränsare {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

// ---------- Reserven i minnet (exporterad för testerna) ----------

const minne = new Map<string, { start: number; antal: number }>();
const STÖRSTA_MINNE = 10_000;

/** Bara för testerna. */
export function nollställMinnet(): void {
  minne.clear();
}

export function iMinnet(nyckel: string, gräns: number, period: number, nu = Date.now()): boolean {
  let r = minne.get(nyckel);
  if (!r || nu - r.start >= period * 1000) {
    if (minne.size >= STÖRSTA_MINNE) {
      for (const [k, v] of minne) if (nu - v.start >= 60_000) minne.delete(k);
      if (minne.size >= STÖRSTA_MINNE) minne.clear();
    }
    r = { start: nu, antal: 0 };
    minne.set(nyckel, r);
  }
  r.antal++;
  return r.antal <= gräns;
}

// ---------- Gränssnittet ----------

/** true om anropet får gå vidare. Räknar anropet. */
export async function tillåt(env: Env, gräns: Gräns, nyckel: string): Promise<boolean> {
  const g = GRÄNSER[gräns];
  const k = `${gräns}:${nyckel}`;
  const b = (env as unknown as Record<string, unknown>)[g.bindning] as Begränsare | undefined;
  if (b && typeof b.limit === "function") {
    try {
      return (await b.limit({ key: k })).success;
    } catch (e) {
      console.error("ratelimit:", gräns, e);
      return true;
    }
  }
  return iMinnet(k, g.gräns, g.period);
}

/** Anroparens IP-adress enligt Cloudflare. */
export function klientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "okänd";
}

/** Sekunder till Retry-After för en gräns. */
export const väntetid = (gräns: Gräns): number => GRÄNSER[gräns].period;

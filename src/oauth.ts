// OAuth 2.1 för MCP-klienter som inte kan skicka en agentnyckel (claude.ai:s kopplare och liknande).
// Resursmetadata (RFC 9728), serverns metadata (RFC 8414), dynamisk registrering (RFC 7591), /authorize med PKCE S256,
// /token (authorization_code och refresh_token) och /revoke (RFC 7009). Allt i D1 (migration 0004); tokens sparas
// bara som SHA-256, som agentnycklarna. Inloggningen är adminlösenordet (ägaren) eller avsändarens personliga länk.

import { AGENTPREFIX, type Omfång } from "./agenter";
import { adminInloggad } from "./admin";
import { hämtaInställningar, nu } from "./db";
import { html, htmlSvar, raw, type Raw } from "./html";
import { base64url, läsCookie, rättLösenord, sha256Hex, slumptoken } from "./krypto";
import { enkelSida } from "./min";
import { json } from "./protokoll";
import { fältrad, rubrik } from "./utseende";

export const ACCESSPREFIX = "ssk_oauth_";
const REFRESHPREFIX = "ssk_refresh_";
const ACCESS_SEKUNDER = 3600;
const REFRESH_DAGAR = 90;
const KOD_SEKUNDER = 600;
/** Hur länge den förra refresh-token gäller efter en förnyelse (om klienten inte hann spara den nya). */
const NÅD_SEKUNDER = 120;
const CSRF_COOKIE = "snicksnack_oauth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const SIDHUVUDEN = {
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

const sekunderFram = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export const förfrågan = () => new Response(null, { status: 204, headers: CORS });

// ---------- Metadata ----------

export function resursmetadata(req: Request): Response {
  const origin = new URL(req.url).origin;
  return json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Snicksnack",
    },
    200,
    { ...CORS, "Cache-Control": "public, max-age=300" },
  );
}

export function servermetadata(req: Request): Response {
  const origin = new URL(req.url).origin;
  return json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    },
    200,
    { ...CORS, "Cache-Control": "public, max-age=300" },
  );
}

/** 401 från /mcp: pekar klienten till resursmetadatan så att den kan starta inloggningen. */
export function obehörig(req: Request, medToken: boolean): Response {
  const origin = new URL(req.url).origin;
  const utmaning =
    `Bearer realm="snicksnack", resource_metadata="${origin}/.well-known/oauth-protected-resource"` +
    (medToken ? ', error="invalid_token", error_description="Invalid, expired or revoked token"' : "");
  return json({ jsonrpc: "2.0", error: { code: -32001, message: "Ogiltig eller saknad inloggning" }, id: null }, 401, {
    "WWW-Authenticate": utmaning,
    "Access-Control-Expose-Headers": "WWW-Authenticate",
  });
}

// ---------- Registrering (RFC 7591) ----------

const FARLIGA_SCHEMAN = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "http:", "https:"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, http bara till den egna datorn, och appars egna scheman (cursor://…). Inget fragment. */
export function giltigRedirect(adress: string): boolean {
  let u: URL;
  try {
    u = new URL(adress);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !FARLIGA_SCHEMAN.has(u.protocol);
}

/** Exakt samma adress, utom att porten får skilja för http till den egna datorn (RFC 8252). */
function sammaRedirect(registrerad: string, given: string): boolean {
  if (registrerad === given) return true;
  try {
    const a = new URL(registrerad);
    const b = new URL(given);
    return (
      a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.has(a.hostname) && a.hostname === b.hostname &&
      a.pathname === b.pathname && a.search === b.search
    );
  } catch {
    return false;
  }
}

const oauthfel = (status: number, fel: string, beskrivning?: string) =>
  json(beskrivning ? { error: fel, error_description: beskrivning } : { error: fel }, status, { ...CORS, Pragma: "no-cache" });

export async function registrera(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > 20_000) return oauthfel(400, "invalid_client_metadata", "För stor");
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error();
  } catch {
    return oauthfel(400, "invalid_client_metadata", "Kroppen ska vara ett JSON-objekt");
  }
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
    return oauthfel(400, "invalid_redirect_uri", "redirect_uris krävs");
  }
  const fel = (uris as string[]).find((u) => !giltigRedirect(u));
  if (fel) return oauthfel(400, "invalid_redirect_uri", `Ogiltig redirect_uri: ${fel}`);
  const typer = m.grant_types;
  if (typer !== undefined && (!Array.isArray(typer) || !typer.includes("authorization_code"))) {
    return oauthfel(400, "invalid_client_metadata", "grant_types måste innehålla authorization_code");
  }
  const namn = (typeof m.client_name === "string" && m.client_name.trim().slice(0, 80)) || "MCP-klient";
  const id = "ssk_client_" + slumptoken(18);
  const skapad = nu();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, namn, JSON.stringify(uris), skapad)
    .run();
  // Bara publika klienter: ingen klienthemlighet, PKCE skyddar koden.
  return json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(Date.parse(skapad) / 1000),
      client_name: namn,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
    CORS,
  );
}

// ---------- /authorize ----------

interface Klient {
  id: string;
  name: string;
  redirect_uris: string;
}

interface Begäran {
  klient: Klient;
  redirect: string;
  state: string | null;
  challenge: string;
  resource: string | null;
}

function tillbaka(redirect: string, origin: string, värden: Record<string, string | null>): Response {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(värden)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", origin);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store", ...SIDHUVUDEN } });
}

async function felsida(env: Env, titel: string, text: string, status = 400): Promise<Response> {
  const s = await hämtaInställningar(env.DB);
  return htmlSvar(enkelSida(s.name, titel, html`<div class="lugn">${rubrik(titel)}<p class="fel">${text}</p></div>`), status, SIDHUVUDEN);
}

/** Läser och kontrollerar begäran. Fel innan redirect-adressen är känd visas som en sida, sedan skickas de tillbaka. */
async function läsBegäran(p: URLSearchParams | FormData, env: Env, origin: string): Promise<Begäran | Response> {
  const v = (n: string) => {
    const x = p.get(n);
    return typeof x === "string" && x !== "" ? x : null;
  };
  const klientId = v("client_id");
  const klient = klientId
    ? await env.DB.prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").bind(klientId).first<Klient>()
    : null;
  if (!klient) return felsida(env, "Okänd klient", "Klienten är inte registrerad här. Ta bort kopplingen och lägg till den igen.");
  const registrerade = JSON.parse(klient.redirect_uris) as string[];
  const given = v("redirect_uri");
  const redirect = given ? (registrerade.some((r) => sammaRedirect(r, given)) ? given : null) : registrerade.length === 1 ? registrerade[0] : null;
  if (!redirect) return felsida(env, "Fel adress", "Adressen klienten vill skicka tillbaka till är inte registrerad.");
  const state = v("state");
  const fel = (kod: string, text: string) => tillbaka(redirect, origin, { error: kod, error_description: text, state });
  if (v("response_type") !== "code") return fel("unsupported_response_type", "Bara response_type=code");
  const challenge = v("code_challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fel("invalid_request", "PKCE krävs: code_challenge (S256)");
  if (v("code_challenge_method") !== "S256") return fel("invalid_request", "Bara code_challenge_method=S256");
  const resource = v("resource");
  if (resource && ![`${origin}/mcp`, `${origin}/mcp/`, origin, `${origin}/`].includes(resource)) {
    return fel("invalid_target", "Okänd resurs");
  }
  return { klient, redirect, state, challenge, resource };
}

async function csrfNyckel(env: Env): Promise<CryptoKey> {
  const hemlighet = env.KEY_SECRET || env.ADMIN_PASSWORD;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("snicksnack-mottagare/oauth-csrf/" + hemlighet),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Formulärets token: bunden till webbläsarens cookie och till begäran. */
async function csrfToken(env: Env, kaka: string, b: Begäran): Promise<string> {
  const text = [kaka, b.klient.id, b.redirect, b.challenge, b.state ?? "", b.resource ?? ""].join("\n");
  const sig = await crypto.subtle.sign("HMAC", await csrfNyckel(env), new TextEncoder().encode(text));
  return base64url(new Uint8Array(sig));
}

async function lika(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
  return crypto.subtle.timingSafeEqual(x, y);
}

function csrfCookie(url: URL, värde: string): string {
  return `${CSRF_COOKIE}=${värde}; Path=/authorize; HttpOnly; SameSite=Lax; Max-Age=3600${url.protocol === "https:" ? "; Secure" : ""}`;
}

export async function auktorisera(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!env.ADMIN_PASSWORD) return felsida(env, "Inte klar", "Servern saknar ADMIN_PASSWORD.", 503);
  if (req.method === "GET") {
    const b = await läsBegäran(url.searchParams, env, url.origin);
    if (b instanceof Response) return b;
    let kaka = läsCookie(req, CSRF_COOKIE);
    const ny = !kaka || !/^[A-Za-z0-9_-]{20,64}$/.test(kaka);
    if (ny) kaka = slumptoken(24);
    return inloggningssida(req, env, b, kaka!, null, 200, ny ? { "Set-Cookie": csrfCookie(url, kaka!) } : {});
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });

  // Safari skickar "Origin: null" på formulär från sidor utan referrer, så "null" släpps igenom;
  // det riktiga skyddet är csrf-fältet som är bundet till kakan (SameSite=Lax).
  const ursprung = req.headers.get("Origin");
  if (ursprung && ursprung !== "null" && ursprung !== url.origin) {
    return felsida(env, "Nekad", "Formuläret kom från en annan sida.", 403);
  }
  const f = await req.formData().catch(() => new FormData());
  const b = await läsBegäran(f, env, url.origin);
  if (b instanceof Response) return b;
  const kaka = läsCookie(req, CSRF_COOKIE);
  const givenCsrf = f.get("csrf");
  if (!kaka || typeof givenCsrf !== "string" || !(await lika(givenCsrf, await csrfToken(env, kaka, b)))) {
    return felsida(env, "Nekad", "Formuläret har gått ut. Gå tillbaka till klienten och försök igen.", 403);
  }
  const val = f.get("val");
  const text = (n: string) => {
    const x = f.get(n);
    return typeof x === "string" ? x.trim() : "";
  };
  if (val === "avsla") return tillbaka(b.redirect, url.origin, { error: "access_denied", error_description: "Användaren avslog", state: b.state });

  let ägare: string | null = null;
  let fel = "";
  if (val === "agare") {
    const lösen = f.get("password");
    if (typeof lösen === "string" && lösen !== "") {
      if (await rättLösenord(env.ADMIN_PASSWORD, lösen)) ägare = "owner";
      else fel = "Fel lösenord.";
    } else if (await adminInloggad(req, env)) {
      ägare = "owner";
    } else fel = "Skriv lösenordet.";
  } else if (val === "avsandare") {
    ägare = await identitetFrånInloggning(env, text("inloggning"));
    if (!ägare) fel = "Länken eller nyckeln fungerar inte.";
  } else {
    fel = "Välj hur du loggar in.";
  }
  if (!ägare) return inloggningssida(req, env, b, kaka, fel, 401);

  const kod = slumptoken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(nu()),
    env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, owner, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256Hex(kod), b.klient.id, ägare, b.redirect, b.challenge, sekunderFram(KOD_SEKUNDER)),
  ]);
  return tillbaka(b.redirect, url.origin, { code: kod, state: b.state });
}

/** Avsändarens personliga länk (eller bara token i den), eller en agentnyckel. Ger 'owner' eller ett sender_id. */
async function identitetFrånInloggning(env: Env, text: string): Promise<string | null> {
  if (!text) return null;
  if (text.startsWith(AGENTPREFIX)) {
    const rad = await env.DB.prepare(
      `SELECT a.owner, s.key_hash AS sender_key FROM agent_keys a LEFT JOIN senders s ON s.id = a.owner WHERE a.key_hash = ?`,
    )
      .bind(await sha256Hex(text))
      .first<{ owner: string; sender_key: string | null }>();
    if (!rad || (rad.owner !== "owner" && !rad.sender_key)) return null;
    return rad.owner;
  }
  let token = text;
  const i = text.indexOf("/min/");
  if (i >= 0) {
    token = text.slice(i + 5).split(/[/?#\s]/)[0];
    try {
      token = decodeURIComponent(token);
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const rad = await env.DB.prepare("SELECT id FROM senders WHERE page_token = ? AND key_hash IS NOT NULL").bind(token).first<{ id: string }>();
  return rad?.id ?? null;
}

async function inloggningssida(
  req: Request,
  env: Env,
  b: Begäran,
  kaka: string,
  fel: string | null,
  status: number,
  huvuden: Record<string, string> = {},
): Promise<Response> {
  const [s, admin, csrf] = await Promise.all([hämtaInställningar(env.DB), adminInloggad(req, env), csrfToken(env, kaka, b)]);
  let mål: string;
  try {
    const u = new URL(b.redirect);
    mål = u.host || u.protocol.replace(/:$/, "");
  } catch {
    mål = b.redirect;
  }
  const dolda = html`<input type="hidden" name="client_id" value="${b.klient.id}" />
    <input type="hidden" name="redirect_uri" value="${b.redirect}" />
    <input type="hidden" name="response_type" value="code" />
    <input type="hidden" name="code_challenge" value="${b.challenge}" />
    <input type="hidden" name="code_challenge_method" value="S256" />
    ${b.state !== null ? html`<input type="hidden" name="state" value="${b.state}" />` : ""}
    ${b.resource !== null ? html`<input type="hidden" name="resource" value="${b.resource}" />` : ""}
    <input type="hidden" name="csrf" value="${csrf}" />`;
  const formulär = (val: string, innehåll: Raw | string) =>
    html`<form method="post" action="/authorize">${dolda}<input type="hidden" name="val" value="${val}" />${innehåll}</form>`;

  return htmlSvar(
    enkelSida(
      s.name,
      "Koppla en klient",
      html`<div class="lugn">
        ${rubrik(`Koppla ${b.klient.name}`, `${b.klient.name} vill läsa snacken på ${s.name}.`)}
        ${fel ? html`<p class="fel">${fel}</p>` : ""}
        <div class="kort">
          <p style="margin-top:0">Klienten får lista, söka och läsa snack, med text, anteckningar och sammanfattningar, och hämta
            ljudet. Den kan inte ändra eller ta bort något. Du kan återkalla kopplingen när som helst.</p>
          <p class="tips">Efter inloggningen skickas du tillbaka till <strong>${mål}</strong>. Namnet ovan har klienten angett själv.</p>
        </div>
        <div class="kort">
          <h3 style="margin-top:0">Som ägare</h3>
          ${admin
            ? formulär(
                "agare",
                html`<p>Du är inloggad i admin. Klienten ser alla snack.</p><button class="bred">Godkänn</button>`,
              )
            : formulär(
                "agare",
                html`${fältrad("Adminlösenord", html`<input type="password" name="password" autocomplete="current-password" required />`, "Klienten ser alla snack.")}
                  <button class="bred">Logga in och godkänn</button>`,
              )}
        </div>
        <div class="kort">
          <h3 style="margin-top:0">Som avsändare</h3>
          ${formulär(
            "avsandare",
            html`${fältrad(
              "Din sida eller en agentnyckel",
              html`<input type="text" name="inloggning" autocomplete="off" spellcheck="false" required placeholder="https://…/min/…" />`,
              "Klistra in länken till Din sida (eller en agentnyckel ssk_agent_…). Klienten ser bara dina egna snack.",
            )}
            <button class="bred">Logga in och godkänn</button>`,
          )}
        </div>
        ${formulär("avsla", raw('<div class="knappar"><button class="farlig">Avslå</button></div>'))}
      </div>`,
    ),
    status,
    { ...SIDHUVUDEN, ...huvuden },
  );
}

// ---------- /token ----------

async function läsKropp(req: Request): Promise<URLSearchParams> {
  const typ = req.headers.get("Content-Type") ?? "";
  const text = new TextDecoder().decode(await req.arrayBuffer());
  if (typ.includes("application/json")) {
    try {
      const o = JSON.parse(text);
      return new URLSearchParams(Object.entries(o ?? {}).filter(([, v]) => typeof v === "string") as [string, string][]);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

/** client_id ur kroppen eller ur Basic-huvudet (en hemlighet där bryr vi oss inte om). */
function klientId(req: Request, p: URLSearchParams): string | null {
  const id = p.get("client_id");
  if (id) return id;
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(atob(m[1]).split(":")[0]) || null;
  } catch {
    return null;
  }
}

async function identitetGiltig(db: D1Database, ägare: string): Promise<boolean> {
  if (ägare === "owner") return true;
  return !!(await db.prepare("SELECT 1 FROM senders WHERE id = ? AND key_hash IS NOT NULL").bind(ägare).first());
}

function nyaTokens() {
  return {
    access: ACCESSPREFIX + base64url(crypto.getRandomValues(new Uint8Array(32))),
    refresh: REFRESHPREFIX + base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

const tokensvar = (t: { access: string; refresh: string }) =>
  json({ access_token: t.access, token_type: "Bearer", expires_in: ACCESS_SEKUNDER, refresh_token: t.refresh }, 200, {
    ...CORS,
    Pragma: "no-cache",
  });

export async function token(req: Request, env: Env): Promise<Response> {
  const p = await läsKropp(req);
  const klient = klientId(req, p);
  const typ = p.get("grant_type");

  if (typ === "authorization_code") {
    const kod = p.get("code");
    const verifier = p.get("code_verifier");
    if (!kod || !verifier) return oauthfel(400, "invalid_request", "code och code_verifier krävs");
    // Koden tas bort när den läses: den går bara att använda en gång.
    const rad = await env.DB.prepare("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *")
      .bind(await sha256Hex(kod))
      .first<{ client_id: string; owner: string; redirect_uri: string; code_challenge: string; expires_at: string }>();
    if (!rad || rad.expires_at < nu()) return oauthfel(400, "invalid_grant", "Koden gäller inte");
    if (klient && klient !== rad.client_id) return oauthfel(400, "invalid_grant", "Koden hör till en annan klient");
    const redirect = p.get("redirect_uri");
    if (redirect && redirect !== rad.redirect_uri) return oauthfel(400, "invalid_grant", "redirect_uri stämmer inte");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthfel(400, "invalid_grant", "Ogiltig code_verifier");
    const hash = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    if (!(await lika(hash, rad.code_challenge))) return oauthfel(400, "invalid_grant", "code_verifier stämmer inte");
    if (!(await identitetGiltig(env.DB, rad.owner))) return oauthfel(400, "invalid_grant", "Avsändaren är spärrad");
    const k = await env.DB.prepare("SELECT name FROM oauth_clients WHERE id = ?").bind(rad.client_id).first<{ name: string }>();
    if (!k) return oauthfel(400, "invalid_grant", "Klienten finns inte längre");
    const t = nyaTokens();
    const tid = nu();
    await env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, client_name, owner, access_hash, access_expires_at, refresh_hash, refreshed_at,
         refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        slumptoken(9),
        rad.client_id,
        k.name,
        rad.owner,
        await sha256Hex(t.access),
        sekunderFram(ACCESS_SEKUNDER),
        await sha256Hex(t.refresh),
        tid,
        sekunderFram(REFRESH_DAGAR * 86400),
        tid,
      )
      .run();
    return tokensvar(t);
  }

  if (typ === "refresh_token") {
    const gammal = p.get("refresh_token");
    if (!gammal) return oauthfel(400, "invalid_request", "refresh_token krävs");
    const h = await sha256Hex(gammal);
    const g = await env.DB.prepare(
      `SELECT id, client_id, owner, refresh_hash, prev_refresh_hash, refreshed_at, refresh_expires_at FROM oauth_grants
       WHERE (refresh_hash = ?1 OR prev_refresh_hash = ?1) AND revoked_at IS NULL`,
    )
      .bind(h)
      .first<{ id: string; client_id: string; owner: string; refresh_hash: string; prev_refresh_hash: string | null; refreshed_at: string; refresh_expires_at: string }>();
    if (!g || g.refresh_expires_at < nu()) return oauthfel(400, "invalid_grant", "Refresh-token gäller inte");
    const viaFörra = g.refresh_hash !== h;
    if (viaFörra && Date.parse(g.refreshed_at) + NÅD_SEKUNDER * 1000 < Date.now()) {
      return oauthfel(400, "invalid_grant", "Refresh-token är redan använd");
    }
    if (klient && klient !== g.client_id) return oauthfel(400, "invalid_grant", "Token hör till en annan klient");
    if (!(await identitetGiltig(env.DB, g.owner))) return oauthfel(400, "invalid_grant", "Avsändaren är spärrad");
    const t = nyaTokens();
    const r = await env.DB.prepare(
      `UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, prev_refresh_hash = ?, refreshed_at = ?,
         refresh_expires_at = ? WHERE id = ? AND revoked_at IS NULL`,
    )
      .bind(
        await sha256Hex(t.access),
        sekunderFram(ACCESS_SEKUNDER),
        await sha256Hex(t.refresh),
        viaFörra ? g.prev_refresh_hash : g.refresh_hash,
        viaFörra ? g.refreshed_at : nu(),
        sekunderFram(REFRESH_DAGAR * 86400),
        g.id,
      )
      .run();
    if (!r.meta.changes) return oauthfel(400, "invalid_grant", "Inloggningen är återkallad");
    return tokensvar(t);
  }

  return oauthfel(400, "unsupported_grant_type", "Bara authorization_code och refresh_token");
}

// ---------- /revoke (RFC 7009) ----------

export async function återkallaToken(req: Request, env: Env): Promise<Response> {
  const p = await läsKropp(req);
  const t = p.get("token");
  if (t) {
    await env.DB.prepare(
      `UPDATE oauth_grants SET revoked_at = ?, access_hash = NULL, refresh_hash = NULL, prev_refresh_hash = NULL
       WHERE (access_hash = ?2 OR refresh_hash = ?2) AND revoked_at IS NULL`,
    )
      .bind(nu(), await sha256Hex(t))
      .run();
  }
  return new Response(null, { status: 200, headers: CORS });
}

// ---------- /mcp ----------

/** Omfånget för en OAuth access-token, eller null. Utgången, återkallad eller spärrad avsändare ger null. */
export async function oauthFrånAnrop(req: Request, env: Env, ctx: ExecutionContext): Promise<Omfång | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m || !m[1].startsWith(ACCESSPREFIX)) return null;
  const rad = await env.DB.prepare(
    `SELECT g.id, g.owner, g.client_name, g.access_expires_at, g.last_used_at, s.key_hash AS sender_key
     FROM oauth_grants g LEFT JOIN senders s ON s.id = g.owner WHERE g.access_hash = ? AND g.revoked_at IS NULL`,
  )
    .bind(await sha256Hex(m[1]))
    .first<{ id: string; owner: string; client_name: string; access_expires_at: string; last_used_at: string | null; sender_key: string | null }>();
  if (!rad || rad.access_expires_at < nu()) return null;
  if (rad.owner !== "owner" && !rad.sender_key) return null;
  // Senast använd: högst en skrivning i minuten.
  if (!rad.last_used_at || Date.parse(rad.last_used_at) < Date.now() - 60_000) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(nu(), rad.id).run().catch((e) => console.error(e)),
    );
  }
  return rad.owner === "owner"
    ? { ägare: true, nyckel: rad.id, klient: rad.client_name }
    : { ägare: false, avsändare: rad.owner, nyckel: rad.id, klient: rad.client_name };
}

// ---------- Listan i admin och på personliga sidan ----------

export interface Inloggning {
  id: string;
  client_name: string;
  owner: string;
  created_at: string;
  last_used_at: string | null;
}

/** Aktiva inloggningar (inte återkallade, refresh-token inte utgången). Med owner bara den identitetens. */
export async function inloggningar(db: D1Database, owner?: string): Promise<Inloggning[]> {
  const sql = `SELECT id, client_name, owner, created_at, last_used_at FROM oauth_grants
    WHERE revoked_at IS NULL AND refresh_expires_at > ?${owner ? " AND owner = ?" : ""} ORDER BY created_at DESC`;
  return (await db.prepare(sql).bind(...(owner ? [nu(), owner] : [nu()])).all<Inloggning>()).results;
}

export async function återkallaInloggning(db: D1Database, id: string, owner?: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE oauth_grants SET revoked_at = ?, access_hash = NULL, refresh_hash = NULL, prev_refresh_hash = NULL
       WHERE id = ? AND revoked_at IS NULL${owner ? " AND owner = ?" : ""}`,
    )
    .bind(...(owner ? [nu(), id, owner] : [nu(), id]))
    .run();
  return r.meta.changes > 0;
}

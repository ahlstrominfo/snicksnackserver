import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { skapaAgentnyckel, sidtoken } from "../src/agenter";
import { base64url } from "../src/krypto";
import { BAS, anropa, paket, skapaAvsändare, skapaMål, skicka, transkript } from "./hjalp";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let annasLänk: string;
let annasAgent: string;

async function registrera(kropp: Record<string, unknown> = { client_name: "Claude", redirect_uris: [REDIRECT] }) {
  return anropa("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kropp) });
}

async function klient(namn = "Claude"): Promise<string> {
  const r = await registrera({ client_name: namn, redirect_uris: [REDIRECT] });
  expect(r.status).toBe(201);
  return (await r.json<any>()).client_id;
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function parametrar(klientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: klientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "tillstand-123",
    resource: `${BAS}/mcp`,
    ...extra,
  });
}

/** GET /authorize: cookien och formulärets csrf-token. */
async function öppna(p: URLSearchParams, huvuden: Record<string, string> = {}) {
  const r = await anropa(`/authorize?${p}`, { headers: huvuden });
  const text = await r.text();
  const kaka = (r.headers.get("Set-Cookie") ?? "").split(";")[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? "";
  return { r, text, kaka, csrf };
}

async function skickaIn(p: URLSearchParams, kaka: string, fält: Record<string, string>) {
  const kropp = new URLSearchParams(p);
  for (const [k, v] of Object.entries(fält)) kropp.set(k, v);
  return anropa("/authorize", { method: "POST", headers: { Cookie: kaka, Origin: BAS }, body: kropp });
}

/** Hela inloggningen fram till koden. */
async function hämtaKod(fält: Record<string, string>, klientId?: string) {
  const id = klientId ?? (await klient());
  const { verifier, challenge } = await pkce();
  const p = parametrar(id, challenge);
  const { kaka, csrf } = await öppna(p);
  const r = await skickaIn(p, kaka, { csrf, ...fält });
  expect(r.status).toBe(302);
  const plats = new URL(r.headers.get("Location")!);
  expect(plats.origin + plats.pathname).toBe(REDIRECT);
  expect(plats.searchParams.get("state")).toBe("tillstand-123");
  expect(plats.searchParams.get("iss")).toBe(BAS);
  return { kod: plats.searchParams.get("code")!, verifier, klientId: id };
}

function tokenAnrop(kropp: Record<string, string>) {
  return anropa("/token", { method: "POST", body: new URLSearchParams(kropp) });
}

async function inloggning(fält: Record<string, string>) {
  const { kod, verifier, klientId } = await hämtaKod(fält);
  const r = await tokenAnrop({ grant_type: "authorization_code", code: kod, code_verifier: verifier, client_id: klientId, redirect_uri: REDIRECT });
  expect(r.status).toBe(200);
  return { ...(await r.json<any>()), klientId };
}

async function rpc(token: string | null, metod: string, params: unknown = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) h.Authorization = `Bearer ${token}`;
  return anropa("/mcp", { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: metod, params }) });
}

async function listaSnack(token: string): Promise<string[]> {
  const r = await rpc(token, "tools/call", { name: "list_snacks", arguments: {} });
  expect(r.status).toBe(200);
  const b = await r.json<any>();
  return JSON.parse(b.result.content[0].text).snacks.map((s: any) => s.id).sort();
}

async function adminCookie(): Promise<string> {
  const r = await anropa("/admin/login", { method: "POST", headers: { Origin: BAS }, body: new URLSearchParams({ password: "testlösen" }) });
  return r.headers.get("Set-Cookie")!.split(";")[0];
}

beforeAll(async () => {
  await skapaMål("o-inbox", "Inkorg");
  const anna = await skapaAvsändare("o-anna", ["o-inbox"]);
  const bosse = await skapaAvsändare("o-bosse", ["o-inbox"]);
  await skicka("o-inbox", anna, paket({ ...transkript("OA1", "Annas snack"), text: "Annas text." }), "OA1");
  await skicka("o-inbox", bosse, paket({ ...transkript("OB1", "Bosses snack"), text: "Bosses text." }), "OB1");
  annasLänk = `${BAS}/min/${await sidtoken(env.DB, "o-anna")}`;
  annasAgent = await skapaAgentnyckel(env.DB, "o-anna", "Annas agent");
});

describe("OAuth-metadata", () => {
  it("resursmetadata pekar på /mcp och servern", async () => {
    for (const väg of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await anropa(väg);
      expect(r.status).toBe(200);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const b = await r.json<any>();
      expect(b.resource).toBe(`${BAS}/mcp`);
      expect(b.authorization_servers).toEqual([BAS]);
    }
  });

  it("servermetadata har det claude.ai kräver", async () => {
    const b = await (await anropa("/.well-known/oauth-authorization-server")).json<any>();
    expect(b.issuer).toBe(BAS);
    expect(b.authorization_endpoint).toBe(`${BAS}/authorize`);
    expect(b.token_endpoint).toBe(`${BAS}/token`);
    expect(b.registration_endpoint).toBe(`${BAS}/register`);
    expect(b.code_challenge_methods_supported).toEqual(["S256"]);
    expect(b.token_endpoint_auth_methods_supported).toContain("none");
    expect(b.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(b.response_types_supported).toEqual(["code"]);
  });

  it("CORS-förfrågan på token och registrering", async () => {
    for (const väg of ["/token", "/register", "/.well-known/oauth-authorization-server"]) {
      const r = await anropa(väg, { method: "OPTIONS" });
      expect(r.status).toBe(204);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("/mcp utan inloggning ger 401 med resource_metadata", async () => {
    const r = await rpc(null, "tools/list");
    expect(r.status).toBe(401);
    const h = r.headers.get("WWW-Authenticate")!;
    expect(h).toContain(`resource_metadata="${BAS}/.well-known/oauth-protected-resource"`);
    expect(h).not.toContain("invalid_token");
    const fel = await rpc("ssk_oauth_finnsinte", "tools/list");
    expect(fel.status).toBe(401);
    expect(fel.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("well-known snicksnack säger att MCP tar både api-key och oauth", async () => {
    const b = await (await anropa("/.well-known/snicksnack")).json<any>();
    expect(b.mcp).toBe(`${BAS}/mcp`);
    expect(b.mcp_auth).toEqual(["api-key", "oauth"]);
  });
});

describe("registrering", () => {
  it("ger en publik klient", async () => {
    const r = await registrera({ client_name: "Claude", redirect_uris: [REDIRECT, "http://localhost:3334/cb"], token_endpoint_auth_method: "client_secret_post" });
    expect(r.status).toBe(201);
    const b = await r.json<any>();
    expect(b.client_id).toMatch(/^ssk_client_/);
    expect(b.token_endpoint_auth_method).toBe("none");
    expect(b.client_secret).toBeUndefined();
    expect(b.redirect_uris).toEqual([REDIRECT, "http://localhost:3334/cb"]);
  });

  it("avvisar osäkra adresser", async () => {
    for (const u of ["http://ond.example/cb", "javascript:alert(1)", "https://x.example/cb#frag", "inte en adress"]) {
      const r = await registrera({ client_name: "X", redirect_uris: [u] });
      expect(r.status).toBe(400);
      expect((await r.json<any>()).error).toBe("invalid_redirect_uri");
    }
    expect((await registrera({ client_name: "X" })).status).toBe(400);
    expect((await anropa("/register", { method: "POST", body: "{" })).status).toBe(400);
  });
});

describe("/authorize", () => {
  it("okänd klient eller oregistrerad adress visas som en sida, inte en redirect", async () => {
    const { challenge } = await pkce();
    const r1 = await anropa(`/authorize?${parametrar("ssk_client_finnsinte", challenge)}`);
    expect(r1.status).toBe(400);
    const id = await klient();
    const r2 = await anropa(`/authorize?${parametrar(id, challenge, { redirect_uri: "https://ond.example/cb" })}`);
    expect(r2.status).toBe(400);
    expect(r2.headers.get("Location")).toBeNull();
  });

  it("kräver PKCE med S256 och känd resurs", async () => {
    const id = await klient();
    const { challenge } = await pkce();
    const fall: Record<string, string>[] = [{ code_challenge: "" }, { code_challenge_method: "plain" }, { resource: "https://annan.example/mcp" }, { response_type: "token" }];
    for (const extra of fall) {
      const r = await anropa(`/authorize?${parametrar(id, challenge, extra)}`);
      expect(r.status).toBe(302);
      const u = new URL(r.headers.get("Location")!);
      expect(u.searchParams.get("error")).toMatch(/invalid_request|invalid_target|unsupported_response_type/);
      expect(u.searchParams.get("state")).toBe("tillstand-123");
    }
  });

  it("visar klientens namn (escapat), sätter en csrf-cookie och går inte att rama in", async () => {
    const id = await klient("<b>Claude</b>");
    const { challenge } = await pkce();
    const { r, text, kaka, csrf } = await öppna(parametrar(id, challenge));
    expect(r.status).toBe(200);
    expect(text).toContain("&lt;b&gt;Claude&lt;/b&gt;");
    expect(text).toContain("claude.ai");
    expect(text).toContain("Som avsändare");
    expect(text).toContain("Adminlösenord");
    expect(kaka).toMatch(/^snicksnack_oauth=/);
    expect(csrf).toBeTruthy();
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("nekar utan rätt csrf, från annat ursprung och med fel lösenord; avslå skickar tillbaka access_denied", async () => {
    const id = await klient();
    const { challenge } = await pkce();
    const p = parametrar(id, challenge);
    const { kaka, csrf } = await öppna(p);
    expect((await skickaIn(p, kaka, { csrf: "fel", val: "agare", password: "testlösen" })).status).toBe(403);
    expect((await skickaIn(p, "snicksnack_oauth=annankakaannankaka1234", { csrf, val: "agare", password: "testlösen" })).status).toBe(403);
    const annat = new URLSearchParams(p);
    annat.set("csrf", csrf);
    annat.set("val", "agare");
    annat.set("password", "testlösen");
    expect((await anropa("/authorize", { method: "POST", headers: { Cookie: kaka, Origin: "https://ond.example" }, body: annat })).status).toBe(403);
    // csrf är bunden till begäran: en annan code_challenge går inte.
    const p2 = parametrar(id, (await pkce()).challenge);
    expect((await skickaIn(p2, kaka, { csrf, val: "agare", password: "testlösen" })).status).toBe(403);
    const fel = await skickaIn(p, kaka, { csrf, val: "agare", password: "fel" });
    expect(fel.status).toBe(401);
    expect(await fel.text()).toContain("Fel lösenord.");
    expect((await skickaIn(p, kaka, { csrf, val: "avsandare", inloggning: `${BAS}/min/finnsintefinnsinte123` })).status).toBe(401);
    const nej = await skickaIn(p, kaka, { csrf, val: "avsla" });
    expect(nej.status).toBe(302);
    expect(new URL(nej.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("en inloggad admin godkänner utan lösenord", async () => {
    const admin = await adminCookie();
    const id = await klient();
    const { verifier, challenge } = await pkce();
    const p = parametrar(id, challenge);
    const { text, kaka, csrf } = await öppna(p, { Cookie: admin });
    expect(text).toContain("Du är inloggad i admin");
    const r = await skickaIn(p, `${kaka}; ${admin}`, { csrf, val: "agare" });
    expect(r.status).toBe(302);
    const kod = new URL(r.headers.get("Location")!).searchParams.get("code")!;
    const t = await tokenAnrop({ grant_type: "authorization_code", code: kod, code_verifier: verifier, client_id: id });
    expect(t.status).toBe(200);
    // Utan admin-cookien och utan lösenord går det inte.
    const { kaka: k2, csrf: c2 } = await öppna(p);
    expect((await skickaIn(p, k2, { csrf: c2, val: "agare" })).status).toBe(401);
  });
});

describe("/token", () => {
  it("fel code_verifier avslås, och koden går bara att använda en gång", async () => {
    const { kod, verifier, klientId } = await hämtaKod({ val: "agare", password: "testlösen" });
    const fel = await tokenAnrop({ grant_type: "authorization_code", code: kod, code_verifier: "x".repeat(43), client_id: klientId });
    expect(fel.status).toBe(400);
    expect((await fel.json<any>()).error).toBe("invalid_grant");
    const igen = await tokenAnrop({ grant_type: "authorization_code", code: kod, code_verifier: verifier, client_id: klientId });
    expect(igen.status).toBe(400);

    const ny = await hämtaKod({ val: "agare", password: "testlösen" });
    const ok = await tokenAnrop({ grant_type: "authorization_code", code: ny.kod, code_verifier: ny.verifier, client_id: ny.klientId });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    const b = await ok.json<any>();
    expect(b.token_type).toBe("Bearer");
    expect(b.expires_in).toBe(3600);
    expect(b.access_token).toMatch(/^ssk_oauth_/);
    expect(b.refresh_token).toMatch(/^ssk_refresh_/);
    const återanvänd = await tokenAnrop({ grant_type: "authorization_code", code: ny.kod, code_verifier: ny.verifier, client_id: ny.klientId });
    expect(återanvänd.status).toBe(400);
  });

  it("koden hör till klienten och redirect-adressen", async () => {
    const a = await hämtaKod({ val: "agare", password: "testlösen" });
    const annan = await klient();
    expect((await tokenAnrop({ grant_type: "authorization_code", code: a.kod, code_verifier: a.verifier, client_id: annan })).status).toBe(400);
    const b = await hämtaKod({ val: "agare", password: "testlösen" });
    const r = await tokenAnrop({ grant_type: "authorization_code", code: b.kod, code_verifier: b.verifier, client_id: b.klientId, redirect_uri: "https://claude.ai/annan" });
    expect(r.status).toBe(400);
  });

  it("tokens sparas bara hashade", async () => {
    const t = await inloggning({ val: "agare", password: "testlösen" });
    const rad = await env.DB.prepare("SELECT * FROM oauth_grants WHERE client_id = ?").bind(t.klientId).first<any>();
    expect(rad.access_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rad)).not.toContain(t.access_token);
    expect(JSON.stringify(rad)).not.toContain(t.refresh_token);
    expect(rad.owner).toBe("owner");
    expect(rad.client_name).toBe("Claude");
  });
});

describe("/mcp med OAuth", () => {
  it("ägaren ser alla snack", async () => {
    const t = await inloggning({ val: "agare", password: "testlösen" });
    const init = await rpc(t.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect((await init.json<any>()).result.serverInfo.name).toBe("snicksnack");
    const lista = await (await rpc(t.access_token, "tools/list")).json<any>();
    expect(lista.result.tools.map((x: any) => x.name)).toContain("list_snacks");
    const ids = await listaSnack(t.access_token);
    expect(ids).toContain("OA1");
    expect(ids).toContain("OB1");
  });

  it("en avsändare med sin länk ser bara sina egna", async () => {
    const t = await inloggning({ val: "avsandare", inloggning: annasLänk });
    expect(await listaSnack(t.access_token)).toEqual(["OA1"]);
    const rad = await env.DB.prepare("SELECT owner FROM oauth_grants WHERE client_id = ?").bind(t.klientId).first<any>();
    expect(rad.owner).toBe("o-anna");
  });

  it("en avsändare med en agentnyckel får samma omfång", async () => {
    const t = await inloggning({ val: "avsandare", inloggning: annasAgent });
    expect(await listaSnack(t.access_token)).toEqual(["OA1"]);
  });

  it("agentnyckeln fungerar fortfarande på /mcp", async () => {
    expect(await listaSnack(annasAgent)).toEqual(["OA1"]);
    const ägarens = await skapaAgentnyckel(env.DB, "owner", "Ägarens");
    expect(await listaSnack(ägarens)).toEqual(expect.arrayContaining(["OA1", "OB1"]));
  });

  it("utgången access-token ger 401 med WWW-Authenticate", async () => {
    const t = await inloggning({ val: "agare", password: "testlösen" });
    await env.DB.prepare("UPDATE oauth_grants SET access_expires_at = '2000-01-01T00:00:00.000Z' WHERE client_id = ?").bind(t.klientId).run();
    const r = await rpc(t.access_token, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("en spärrad avsändares inloggning slutar fungera", async () => {
    const nyckel = await skapaAvsändare("o-cissi", ["o-inbox"]);
    expect(nyckel).toBeTruthy();
    const länk = `${BAS}/min/${await sidtoken(env.DB, "o-cissi")}`;
    const t = await inloggning({ val: "avsandare", inloggning: länk });
    expect((await rpc(t.access_token, "tools/list")).status).toBe(200);
    await env.DB.prepare("UPDATE senders SET key_hash = NULL WHERE id = 'o-cissi'").run();
    expect((await rpc(t.access_token, "tools/list")).status).toBe(401);
    expect((await tokenAnrop({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
  });
});

describe("refresh och återkallande", () => {
  it("refresh ger nya tokens; den gamla access-token slutar gälla", async () => {
    const t = await inloggning({ val: "avsandare", inloggning: annasLänk });
    const r = await tokenAnrop({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.klientId });
    expect(r.status).toBe(200);
    const n = await r.json<any>();
    expect(n.access_token).not.toBe(t.access_token);
    expect(n.refresh_token).not.toBe(t.refresh_token);
    expect(await listaSnack(n.access_token)).toEqual(["OA1"]);
    expect((await rpc(t.access_token, "tools/list")).status).toBe(401);
    // Den förra refresh-token gäller en kort stund till, sedan inte.
    expect((await tokenAnrop({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(200);
    await env.DB.prepare("UPDATE oauth_grants SET refreshed_at = '2000-01-01T00:00:00.000Z' WHERE client_id = ?").bind(t.klientId).run();
    expect((await tokenAnrop({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
    expect((await tokenAnrop({ grant_type: "refresh_token", refresh_token: "ssk_refresh_fel" })).status).toBe(400);
    expect((await tokenAnrop({ grant_type: "password" })).status).toBe(400);
  });

  it("ägaren återkallar i admin; listan visar klienten", async () => {
    const t = await inloggning({ val: "avsandare", inloggning: annasLänk });
    const admin = await adminCookie();
    const sida = await (await anropa("/admin/agenter", { headers: { Cookie: admin } })).text();
    expect(sida).toContain("Inloggade klienter");
    expect(sida).toContain("O-ANNA");
    const id = (await env.DB.prepare("SELECT id FROM oauth_grants WHERE client_id = ?").bind(t.klientId).first<{ id: string }>())!.id;
    expect(sida).toContain(`/admin/agenter/klienter/${id}/aterkalla`);
    const r = await anropa(`/admin/agenter/klienter/${id}/aterkalla`, { method: "POST", headers: { Cookie: admin, Origin: BAS } });
    expect(r.status).toBe(303);
    const svar = await rpc(t.access_token, "tools/list");
    expect(svar.status).toBe(401);
    expect(svar.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect((await tokenAnrop({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
  });

  it("avsändaren ser och återkallar sina egna på sin sida, men inte andras", async () => {
    const egen = await inloggning({ val: "avsandare", inloggning: annasLänk });
    const ägarens = await inloggning({ val: "agare", password: "testlösen" });
    const bas = new URL(annasLänk).pathname;
    const sida = await (await anropa(bas)).text();
    expect(sida).toContain("Inloggade klienter");
    expect(sida).toContain("claude.ai");
    const [egenId, ägarId] = await Promise.all(
      [egen.klientId, ägarens.klientId].map(
        async (k) => (await env.DB.prepare("SELECT id FROM oauth_grants WHERE client_id = ?").bind(k).first<{ id: string }>())!.id,
      ),
    );
    expect(sida).toContain(`/klienter/${egenId}/aterkalla`);
    expect(sida).not.toContain(`/klienter/${ägarId}/aterkalla`);
    await anropa(`${bas}/klienter/${ägarId}/aterkalla`, { method: "POST", headers: { Origin: BAS } });
    expect((await rpc(ägarens.access_token, "tools/list")).status).toBe(200);
    await anropa(`${bas}/klienter/${egenId}/aterkalla`, { method: "POST", headers: { Origin: BAS } });
    expect((await rpc(egen.access_token, "tools/list")).status).toBe(401);
  });

  it("/revoke återkallar med token", async () => {
    const t = await inloggning({ val: "agare", password: "testlösen" });
    const r = await anropa("/revoke", { method: "POST", body: new URLSearchParams({ token: t.refresh_token }) });
    expect(r.status).toBe(200);
    expect((await rpc(t.access_token, "tools/list")).status).toBe(401);
  });
});

// Säkerhetshärdningen: rate limits, spärren efter fel lösenord, revisionsloggen, kvoterna, ljud- och
// transkriptkontrollen, säkerhetshuvudena och den nattliga städningen.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/krypto";
import { ljudformat, transkriptFel } from "../src/protokoll";
import { iMinnet, nollställMinnet, tillåt } from "../src/ratelimit";
import { rensaLogg } from "../src/revision";
import { städa } from "../src/stadning";
import { BAS, anropa, m4a, paket, skapaAvsändare, skapaMål, skicka, transkript, wav } from "./hjalp";

const IP = (n: number) => ({ "CF-Connecting-IP": `192.0.2.${n}` });

function loggaIn(lösen: string, ip: number) {
  return anropa("/admin/login", { method: "POST", headers: { Origin: BAS, ...IP(ip) }, body: new URLSearchParams({ password: lösen }) });
}

async function kaka(): Promise<string> {
  return (await loggaIn("testlösen", 200)).headers.get("Set-Cookie")!.split(";")[0];
}

async function händelser(händelse: string): Promise<{ detail: string; actor: string; ip: string | null }[]> {
  return (await env.DB.prepare("SELECT detail, actor, ip FROM audit WHERE event = ? ORDER BY id").bind(händelse).all<any>()).results;
}

let nyckel: string;

/** Registrerar en klient, öppnar /authorize och loggar in som ägaren med lösenordet från en viss IP. */
async function authorizeMedLösen(lösen: string, ip: number): Promise<Response> {
  const reg = await (
    await anropa("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) })
  ).json<{ client_id: string }>();
  const p = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: "https://claude.ai/cb",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
  const sida = await anropa(`/authorize?${p}`, { headers: IP(ip) });
  const kaka = sida.headers.get("Set-Cookie")!.split(";")[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await sida.text())![1];
  const kropp = new URLSearchParams(p);
  kropp.set("csrf", csrf);
  kropp.set("val", "agare");
  kropp.set("password", lösen);
  return anropa("/authorize", { method: "POST", headers: { Cookie: kaka, Origin: BAS, ...IP(ip) }, body: kropp });
}

beforeAll(async () => {
  await skapaMål("s-inbox", "Inkorg");
  nyckel = await skapaAvsändare("s-anna", ["s-inbox"]);
  await env.DB.prepare("INSERT INTO sender_prompts (sender_id, prompt_id) VALUES ('s-anna', 'kort-sammanfattning'), ('s-anna', 'sammanfatta-hittills')").run();
});

describe("rate limit-modulen", () => {
  it("räknar i minnet per nyckel och period när bindningen saknas", async () => {
    nollställMinnet();
    const utan = {} as Env;
    const svar = [];
    for (let i = 0; i < 6; i++) svar.push(await tillåt(utan, "inloggning", "1.2.3.4"));
    expect(svar).toEqual([true, true, true, true, true, false]);
    expect(await tillåt(utan, "inloggning", "5.6.7.8")).toBe(true);
    // En ny period börjar om
    expect(iMinnet("x", 1, 60, 1000)).toBe(true);
    expect(iMinnet("x", 1, 60, 2000)).toBe(false);
    expect(iMinnet("x", 1, 60, 61_000)).toBe(true);
    nollställMinnet();
  });

  it("använder bindningen när den finns och släpper igenom om den kastar", async () => {
    const nycklar: string[] = [];
    const med = { RL_AI: { limit: async (o: { key: string }) => (nycklar.push(o.key), { success: false }) } } as unknown as Env;
    expect(await tillåt(med, "ai", "anna")).toBe(false);
    expect(nycklar).toEqual(["ai:anna"]);
    const trasig = { RL_AI: { limit: async () => { throw new Error("nere"); } } } as unknown as Env;
    expect(await tillåt(trasig, "ai", "anna")).toBe(true);
  });
});

describe("rate limits i Workern", () => {
  it("admin: sjätte inloggningen på en minut från samma IP ger 429 med Retry-After", async () => {
    const svar = [];
    for (let i = 0; i < 6; i++) svar.push(await loggaIn("fel", 1));
    expect(svar.slice(0, 5).map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(svar[5].status).toBe(429);
    expect(svar[5].headers.get("Retry-After")).toBe("60");
    expect(await svar[5].text()).toContain("För många försök");
    // En annan adress påverkas inte
    expect((await loggaIn("testlösen", 2)).status).toBe(303);
  });

  it("ogiltiga nycklar: efter 20 från samma IP svarar mottagningen 429", async () => {
    const svar = [];
    for (let i = 0; i < 21; i++) {
      svar.push((await anropa("/snicksnack/receive/s-inbox", { method: "POST", headers: { Authorization: "Bearer ssk_fel", ...IP(3) } })).status);
    }
    expect(svar.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(svar[20]).toBe(429);
  });

  it("MCP och /min: gissning från samma IP ger 429", async () => {
    let mcp = 0;
    for (let i = 0; i < 21; i++) {
      mcp = (await anropa("/mcp", { method: "POST", headers: { Authorization: "Bearer ssk_agent_fel", ...IP(4) }, body: "{}" })).status;
    }
    expect(mcp).toBe(429);
    let min = 0;
    for (let i = 0; i < 21; i++) min = (await anropa("/min/finns-inte-alls-0123456789", { headers: IP(5) })).status;
    expect(min).toBe(429);
  });

  it("/register: elfte registreringen på en minut från samma IP ger 429", async () => {
    let sista: Response | null = null;
    for (let i = 0; i < 11; i++) {
      sista = await anropa("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...IP(6) },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["https://claude.ai/cb"] }),
      });
    }
    expect(sista!.status).toBe(429);
    expect(sista!.headers.get("Retry-After")).toBe("60");
  });
});

describe("spärren efter fel lösenord", () => {
  it("20 fel från en IP på en timme spärrar den i en timme, också med rätt lösenord", async () => {
    const tid = new Date(Date.now() - 600_000).toISOString();
    for (let i = 0; i < 19; i++) await env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES ('192.0.2.10', ?)").bind(tid).run();
    expect((await loggaIn("fel", 10)).status).toBe(401);
    const spärrad = await loggaIn("testlösen", 10);
    expect(spärrad.status).toBe(429);
    expect(Number(spärrad.headers.get("Retry-After"))).toBeGreaterThan(3500);
    expect(spärrad.headers.get("Set-Cookie")).toBeNull();
    const rader = await händelser("inloggning.sparr");
    expect(rader.at(-1)!.detail).toContain("20 fel lösenord från 192.0.2.10");
    // Ägarens väg i /authorize är spärrad på samma sätt (samma lösenord).
    expect((await authorizeMedLösen("testlösen", 10)).status).toBe(429);
    expect((await loggaIn("testlösen", 11)).status).toBe(303);
    await env.DB.prepare("DELETE FROM login_locks").run();
  });

  it("många fel från alla adresser spärrar inloggningen för alla", async () => {
    const tid = new Date(Date.now() - 600_000).toISOString();
    for (let i = 0; i < 99; i++) await env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(`198.51.100.${i}`, tid).run();
    expect((await loggaIn("fel", 12)).status).toBe(401);
    expect((await loggaIn("testlösen", 13)).status).toBe(429);
    expect((await händelser("inloggning.sparr")).at(-1)!.detail).toContain("alla adresser");
    await env.DB.batch([env.DB.prepare("DELETE FROM login_locks"), env.DB.prepare("DELETE FROM login_failures")]);
    expect((await loggaIn("testlösen", 13)).status).toBe(303);
  });

  it("fel lösenord i /authorize räknas och loggas, och rätt ger en kod", async () => {
    const fel = await authorizeMedLösen("fel", 15);
    expect(fel.status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = '192.0.2.15'").first<{ n: number }>())!.n).toBe(1);
    expect((await händelser("oauth.fel")).length).toBeGreaterThan(0);
    const ok = await authorizeMedLösen("testlösen", 15);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toContain("code=");
    expect((await händelser("oauth.godkand")).at(-1)!.actor).toBe("ägaren");
  });

  it("lyckad inloggning nollställer adressens räknare", async () => {
    await env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES ('192.0.2.14', ?)").bind(new Date().toISOString()).run();
    expect((await loggaIn("testlösen", 14)).status).toBe(303);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = '192.0.2.14'").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("revisionsloggen", () => {
  it("loggar inloggningar med IP och kort user agent, och visar dem under Logg", async () => {
    await anropa("/admin/login", {
      method: "POST",
      headers: { Origin: BAS, ...IP(20), "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1" },
      body: new URLSearchParams({ password: "fel" }),
    });
    const rad = await env.DB.prepare("SELECT * FROM audit WHERE event = 'inloggning.fel' AND ip = '192.0.2.20'").first<any>();
    expect(rad).toMatchObject({ actor: "okänd", ua: "Safari på iPhone/iPad" });
    const k = await kaka();
    const sida = await anropa("/admin/logg", { headers: { Cookie: k } });
    expect(sida.status).toBe(200);
    const html = await sida.text();
    expect(html).toContain("Fel adminlösenord");
    expect(html).toContain("Inloggning i admin");
    expect(html).toContain('aria-current="page">Logg');
  });

  it("loggar nycklar, länkar, inställningar och borttagna snack", async () => {
    const k = await kaka();
    const post = (väg: string, kropp: URLSearchParams = new URLSearchParams()) =>
      anropa(väg, { method: "POST", headers: { Cookie: k, Origin: BAS }, body: kropp });
    await post("/admin/avsandare", new URLSearchParams({ name: "Loggad Person" }));
    await post("/admin/avsandare/loggad-person/ny-nyckel");
    await post("/admin/avsandare/loggad-person/ny-sida");
    await post("/admin/avsandare/loggad-person/sparra");
    await post("/admin/agenter", new URLSearchParams({ name: "Loggagent" }));
    await post("/admin/installningar", new URLSearchParams({ name: "Mottagaren", no_color: "on", accepts: "transcript" }));
    await skicka("s-inbox", nyckel, paket(transkript("radera-mig", "Radera mig")), "radera-mig");
    await post("/admin/snack/s-inbox/s-anna/radera-mig/ta-bort");
    for (const h of ["avsandare.skapad", "avsandare.ny_nyckel", "avsandare.ny_sida", "avsandare.sparrad", "agentnyckel.skapad", "installningar.andrade", "snack.raderat"]) {
      expect((await händelser(h)).length, h).toBeGreaterThan(0);
    }
    expect((await händelser("snack.raderat")).at(-1)!.detail).toContain("Radera mig");
    // Inga nycklar i klartext i loggen
    const alla = (await env.DB.prepare("SELECT detail FROM audit").all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
    expect(alla).not.toMatch(/ssk_[A-Za-z0-9_-]{20,}/);
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("rensar rader äldre än 90 dagar", async () => {
    await env.DB.prepare("INSERT INTO audit (at, event, actor, detail) VALUES (?, 'inloggning.ok', 'ägaren', 'gammal')")
      .bind(new Date(Date.now() - 91 * 86400_000).toISOString())
      .run();
    expect(await rensaLogg(env.DB)).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT 1 FROM audit WHERE detail = 'gammal'").first()).toBeNull();
  });
});

describe("kvoter", () => {
  const sammanfatta = () =>
    anropa("/snicksnack/summarize/kort-sammanfattning", {
      method: "POST",
      headers: { Authorization: `Bearer ${nyckel}`, "Content-Type": "application/json" },
      body: JSON.stringify(transkript("K1", "Kvot")),
    });

  it("AI-anrop per dygn: avsändarens kvot ger 429 med text", async () => {
    await env.DB.prepare("UPDATE senders SET quota_ai_requests_day = 1 WHERE id = 's-anna'").run();
    expect((await sammanfatta()).status).toBe(200);
    // Förbrukningen räknas efter svaret (waitUntil); vänta tills raden finns.
    for (let i = 0; i < 50 && !(await env.DB.prepare("SELECT 1 FROM usage WHERE sender_id = 's-anna'").first()); i++) await new Promise((r) => setTimeout(r, 20));
    const r = await sammanfatta();
    expect(r.status).toBe(429);
    expect((await r.json<{ error: string }>()).error).toContain("Dagens AI-anrop är slut");
    const chatt = await anropa("/snicksnack/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${nyckel}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: null, messages: [{ role: "user", content: "Hej?" }], transcript: transkript("K1", "Kvot") }),
    });
    expect(chatt.status).toBe(429);

    const k = await kaka();
    expect(await (await anropa("/admin/avsandare", { headers: { Cookie: k } })).text()).toContain("AI i dag 1 av 1 anrop");
    await env.DB.prepare("UPDATE senders SET quota_ai_requests_day = NULL WHERE id = 's-anna'").run();
    expect((await sammanfatta()).status).toBe(200);
  });

  it("standarden under Inställningar gäller avsändare utan egen kvot", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings VALUES ('quota_ai_tokens_30d', '0')").run();
    const r = await sammanfatta();
    expect(r.status).toBe(429);
    expect((await r.json<{ error: string }>()).error).toContain("AI-kvoten för 30 dagar är slut");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'quota_ai_tokens_30d'").run();
  });

  it("den globala AI-budgeten stoppar alla", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings VALUES ('ai_budget_tokens_30d', '0')").run();
    const r = await sammanfatta();
    expect(r.status).toBe(429);
    expect((await r.json<{ error: string }>()).error).toContain("AI-budget");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'ai_budget_tokens_30d'").run();
  });

  it("lagringen: ett snack som inte får plats nekas med 429 och text; omsändning räknar bort det som ersätts", async () => {
    await env.DB.prepare("UPDATE senders SET quota_storage_mb = 0 WHERE id = 's-anna'").run();
    const r = await skicka("s-inbox", nyckel, paket(transkript("fullt", "Fullt")), "fullt");
    expect(r.status).toBe(429);
    expect((await r.json<{ error: string }>()).error).toContain("Lagringen hos");
    expect(await env.FILER.head("s-inbox/s-anna/fullt/transcript.json")).toBeNull();

    await env.DB.prepare("UPDATE senders SET quota_storage_mb = 1 WHERE id = 's-anna'").run();
    // MAX_BYTES är 20 000 i testerna: fyll i stället kvoten med ett snack som bara finns i indexet.
    await env.DB.prepare(
      `INSERT INTO snacks (target_id, sender_id, snack_id, bytes, received_at, updated_at) VALUES ('s-inbox', 's-anna', 'stort', ?, ?, ?)`,
    )
      .bind(1024 * 1024 - 100, new Date().toISOString(), new Date().toISOString())
      .run();
    expect((await skicka("s-inbox", nyckel, paket(transkript("litet", "Litet")), "litet")).status).toBe(429);
    await env.DB.prepare("DELETE FROM snacks WHERE snack_id = 'stort'").run();
    expect((await skicka("s-inbox", nyckel, paket(transkript("litet", "Litet")), "litet")).status).toBe(201);
    expect((await skicka("s-inbox", nyckel, paket(transkript("litet", "Litet igen")), "litet")).status).toBe(200);
    await env.DB.prepare("UPDATE senders SET quota_storage_mb = NULL WHERE id = 's-anna'").run();
  });

  it("personliga sidan visar förbrukningen", async () => {
    const { bytSidtoken } = await import("../src/agenter");
    const token = (await bytSidtoken(env.DB, "s-anna"))!;
    const html = await (await anropa(`/min/${token}`)).text();
    expect(html.match(/Förbrukning:[^<]*/)?.[0]).toMatch(/^Förbrukning: AI i dag \d+ anrop · 30 dagar \d+ tokens · lagring [\d,]+ MB\.$/);
  });

  it("admin sparar kvoter och nekar trasiga värden", async () => {
    const k = await kaka();
    const post = (väg: string, kropp: URLSearchParams) => anropa(väg, { method: "POST", headers: { Cookie: k, Origin: BAS }, body: kropp });
    const fel = await post("/admin/avsandare/s-anna", new URLSearchParams({ name: "S-ANNA", quota_storage_mb: "mycket" }));
    expect(fel.status).toBe(400);
    expect(await fel.text()).toContain("ska vara ett heltal");
    expect((await post("/admin/avsandare/s-anna", new URLSearchParams({ name: "S-ANNA", targets: "s-inbox", quota_storage_mb: "500" }))).status).toBe(303);
    expect((await env.DB.prepare("SELECT quota_storage_mb AS l FROM senders WHERE id = 's-anna'").first<{ l: number }>())!.l).toBe(500);
    expect((await post("/admin/installningar", new URLSearchParams({ name: "M", no_color: "on", accepts: "transcript", ai_budget_tokens_30d: "1 000 000" }))).status).toBe(303);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'ai_budget_tokens_30d'").first<{ value: string }>())!.value).toBe("1000000");
    await env.DB.prepare("DELETE FROM settings").run();
    await env.DB.prepare("UPDATE senders SET quota_storage_mb = NULL WHERE id = 's-anna'").run();
  });
});

describe("ljudet och transkriptet", () => {
  it("känner igen wav och m4a på de första byten", () => {
    expect(ljudformat(wav(1, 2))).toBe("wav");
    expect(ljudformat(m4a(1, 2))).toBe("m4a");
    expect(ljudformat(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(ljudformat(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("annat än wav eller m4a nekas med 415, och formatet avgör filnamnet", async () => {
    const r = await skicka("s-inbox", nyckel, paket(transkript("fel-ljud", "Fel"), { ljud: new TextEncoder().encode("<html>hej</html>") }), "fel-ljud");
    expect(r.status).toBe(415);
    expect((await r.json<{ error: string }>()).error).toContain("m4a");
    expect(await env.FILER.head("s-inbox/s-anna/fel-ljud/transcript.json")).toBeNull();
    // wav som heter .m4a sparas som wav
    const ok = await skicka("s-inbox", nyckel, paket(transkript("wav-ljud", "Wav"), { ljud: wav(1, 2, 3), ljudnamn: "x.m4a" }), "wav-ljud");
    expect(ok.status).toBe(201);
    expect(await env.FILER.head("s-inbox/s-anna/wav-ljud/audio.wav")).not.toBeNull();
  });

  it("transkriptet ska ha rimliga fält, annars 400", async () => {
    expect(transkriptFel(transkript("ok", "Ok") as any)).toBeNull();
    expect(transkriptFel({ id: "x" })).toContain("words");
    expect(transkriptFel({ id: 5, words: [] })).toContain("id");
    expect(transkriptFel({ id: "x", words: [{ start: 1 }] })).toContain("text");
    expect(transkriptFel({ id: "x", words: [], tags: [1] })).toContain("tags");
    expect(transkriptFel({ id: "x", words: [], duration: "lång" })).toContain("duration");
    const r = await skicka("s-inbox", nyckel, paket({ id: "utan-ord", title: "Utan ord" }), "utan-ord");
    expect(r.status).toBe(400);
    expect((await r.json<{ error: string }>()).error).toBe("transcript.words ska vara en lista");
  });
});

describe("säkerhetshuvuden", () => {
  it("admin-sidorna har CSP med nonce på skriptet, och inga inline-händelser", async () => {
    const r = await anropa("/admin/login");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(r.headers.get("Permissions-Policy")).toContain("camera=()");
    const csp = r.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    const html = await r.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/<script>/);
    // En ny nonce per svar
    const andra = (await anropa("/admin/login")).headers.get("Content-Security-Policy")!;
    expect(andra).not.toContain(nonce);

    const sida = await (await anropa("/admin/avsandare", { headers: { Cookie: await kaka() } })).text();
    expect(sida).not.toMatch(/\son[a-z]+="/);
    expect(sida).toContain("data-bekrafta=");
  });

  it("personliga sidan, felsidor och OAuth-inloggningen har huvudena", async () => {
    const min = await anropa("/min/finns-inte-0123456789abcdef");
    expect(min.status).toBe(404);
    expect(min.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(min.headers.get("Referrer-Policy")).toBe("no-referrer");
    const fel = await anropa("/authorize?client_id=finns-inte");
    expect(fel.headers.get("X-Frame-Options")).toBe("DENY");
    const reg = await (
      await anropa("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) })
    ).json<{ client_id: string }>();
    const p = new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: "https://claude.ai/cb",
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const auth = await anropa(`/authorize?${p}`);
    expect(auth.status).toBe(200);
    const csp = auth.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    // Formuläret skickas vidare till klientens adress: ingen form-action.
    expect(csp).not.toContain("form-action");
  });

  it("JSON-svar har nosniff", async () => {
    expect((await anropa("/.well-known/snicksnack")).headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("städningen", () => {
  it("tar bort oanvända klienter, utgångna koder och inloggningar, gamla loggrader och spärrar, och hashar gamla länkar", async () => {
    const gammal = new Date(Date.now() - 2 * 86400_000).toISOString();
    const längeSedan = new Date(Date.now() - 30 * 86400_000).toISOString();
    const nyss = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('c-gammal', 'x', '[]', ?)").bind(gammal),
      env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('c-ny', 'x', '[]', ?)").bind(nyss),
      env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('c-anvand', 'x', '[]', ?)").bind(gammal),
      env.DB.prepare(
        `INSERT INTO oauth_grants (id, client_id, client_name, owner, refresh_expires_at, created_at) VALUES ('g-aktiv', 'c-anvand', 'x', 'owner', ?, ?)`,
      ).bind(new Date(Date.now() + 86400_000).toISOString(), gammal),
      env.DB.prepare(
        `INSERT INTO oauth_grants (id, client_id, client_name, owner, refresh_expires_at, created_at, revoked_at) VALUES ('g-aterkallad', 'c-x', 'x', 'owner', ?, ?, ?)`,
      ).bind(new Date(Date.now() + 86400_000).toISOString(), längeSedan, längeSedan),
      env.DB.prepare(
        `INSERT INTO oauth_grants (id, client_id, client_name, owner, refresh_expires_at, created_at) VALUES ('g-utgangen', 'c-x', 'x', 'owner', ?, ?)`,
      ).bind(gammal, längeSedan),
      env.DB.prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, owner, redirect_uri, code_challenge, expires_at) VALUES ('k-gammal', 'c-x', 'owner', 'x', 'x', ?)",
      ).bind(gammal),
      env.DB.prepare("INSERT INTO audit (at, event, actor, detail) VALUES (?, 'inloggning.ok', 'ägaren', 'städas')").bind(
        new Date(Date.now() - 100 * 86400_000).toISOString(),
      ),
      env.DB.prepare("INSERT INTO login_failures (ip, at) VALUES ('203.0.113.1', ?)").bind(gammal),
      env.DB.prepare("INSERT INTO login_locks (scope, until) VALUES ('ip:203.0.113.1', ?)").bind(gammal),
    ]);
    await skapaAvsändare("s-klartext", []);
    await env.DB.prepare("UPDATE senders SET page_token = 'klartext-0123456789abcdef', page_hash = NULL WHERE id = 's-klartext'").run();

    const r = await städa(env);
    expect(r.klienter).toBeGreaterThanOrEqual(1);
    expect(r.sidlänkar).toBe(1);
    const ids = (await env.DB.prepare("SELECT id FROM oauth_clients WHERE id LIKE 'c-%'").all<{ id: string }>()).results.map((x) => x.id).sort();
    expect(ids).toEqual(["c-anvand", "c-ny"]);
    const grants = (await env.DB.prepare("SELECT id FROM oauth_grants WHERE id LIKE 'g-%'").all<{ id: string }>()).results.map((x) => x.id);
    expect(grants).toEqual(["g-aktiv"]);
    expect(await env.DB.prepare("SELECT 1 FROM oauth_codes WHERE code_hash = 'k-gammal'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit WHERE detail = 'städas'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM login_failures WHERE ip = '203.0.113.1'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM login_locks").first()).toBeNull();
    const s = (await env.DB.prepare("SELECT page_token, page_hash FROM senders WHERE id = 's-klartext'").first<any>())!;
    expect(s.page_token).toBeNull();
    expect(s.page_hash).toBe(await sha256Hex("klartext-0123456789abcdef"));
  });
});

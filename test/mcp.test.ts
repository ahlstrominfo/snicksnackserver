import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { skapaAgentnyckel } from "../src/agenter";
import { BAS, anropa, paket, skapaAvsändare, skapaMål, skicka, transkript } from "./hjalp";

let ägarnyckel: string;
let annasAgent: string;
let bossesAgent: string;

async function rpc(nyckel: string | null, metod: string, params: unknown = {}, id = 1) {
  const huvuden: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (nyckel) huvuden.Authorization = `Bearer ${nyckel}`;
  return anropa("/mcp", { method: "POST", headers: huvuden, body: JSON.stringify({ jsonrpc: "2.0", id, method: metod, params }) });
}

async function verktyg(nyckel: string, namn: string, args: Record<string, unknown> = {}) {
  const r = await rpc(nyckel, "tools/call", { name: namn, arguments: args });
  expect(r.status).toBe(200);
  const b = await r.json<any>();
  const text = b.result.content[0].text as string;
  return { fel: !!b.result.isError, text, data: b.result.isError ? null : JSON.parse(text) };
}

beforeAll(async () => {
  await skapaMål("inbox", "Inkorg");
  await skapaMål("kunder", "Kunder");
  const anna = await skapaAvsändare("anna", ["inbox", "kunder"]);
  const bosse = await skapaAvsändare("bosse", ["inbox"]);
  const a1 = {
    ...transkript("A1", "Styrgrupp om fjärrvärmen"),
    recorded_at: "2026-10-10T09:30:12+02:00",
    note: "Kom ihåg taxan",
    speakers: { "0": "Anna", "1": "Bosse" },
    text: "Vi börjar. Taxan höjs med tre procent.",
    words: [
      { text: "Vi", start: 0.3, end: 0.5, speaker: 0 },
      { text: "börjar.", start: 0.5, end: 0.9, speaker: 0 },
      { text: "Taxan", start: 2.0, end: 2.4, speaker: 1 },
      { text: "höjs", start: 2.4, end: 2.6, speaker: 1 },
      { text: "med", start: 2.6, end: 2.7, speaker: 1 },
      { text: "tre", start: 2.7, end: 2.8, speaker: 1 },
      { text: "procent.", start: 2.8, end: 3.2, speaker: 1 },
    ],
    summaries: [{ kind: "decisions", created_at: "2026-10-10T10:00:00+02:00", items: [{ section: "Beslut", text: "Taxan höjs.", speaker: 1, at: 2.0 }] }],
  };
  await skicka("kunder", anna, paket(a1, { text: "# Styrgrupp", ljud: new Uint8Array([1, 2, 3, 4, 0x66, 0x74, 0x79, 0x70, 5, 6]) }), "A1");
  await skicka("inbox", anna, paket({ ...transkript("A2", "Promenadtanke"), recorded_at: "2026-10-12T08:00:00+02:00", tags: ["ide"], text: "En idé om cyklar." }), "A2");
  await skicka("inbox", bosse, paket({ ...transkript("B1", "Bosses hemliga möte"), recorded_at: "2026-10-11T08:00:00+02:00", text: "Hemligt om taxan." }), "B1");
  ägarnyckel = await skapaAgentnyckel(env.DB, "owner", "Testägare");
  annasAgent = await skapaAgentnyckel(env.DB, "anna", "Annas Claude");
  bossesAgent = await skapaAgentnyckel(env.DB, "bosse", "Bosses Claude");
});

describe("agentnycklar", () => {
  it("401 utan nyckel, med en avsändarnyckel och med en spärrad agentnyckel", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("ssk_agent_fel", "tools/list")).status).toBe(401);
    const n = await skapaAgentnyckel(env.DB, "owner", "Kortlivad");
    expect((await rpc(n, "tools/list")).status).toBe(200);
    const id = (await env.DB.prepare("SELECT id FROM agent_keys WHERE name = 'Kortlivad'").first<{ id: string }>())!.id;
    await env.DB.prepare("UPDATE agent_keys SET key_hash = NULL, revoked_at = 'x' WHERE id = ?").bind(id).run();
    expect((await rpc(n, "tools/list")).status).toBe(401);
  });

  it("sparas hashad och uppdaterar last_used_at", async () => {
    const rad = await env.DB.prepare("SELECT * FROM agent_keys WHERE name = 'Testägare'").first<any>();
    expect(rad.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ägarnyckel.startsWith("ssk_agent_")).toBe(true);
    await rpc(ägarnyckel, "ping");
    await new Promise((r) => setTimeout(r, 50));
    const efter = await env.DB.prepare("SELECT last_used_at FROM agent_keys WHERE name = 'Testägare'").first<any>();
    expect(efter.last_used_at).toBeTruthy();
  });

  it("en spärrad avsändares agentnycklar slutar fungera", async () => {
    const n = await skapaAvsändare("cissi", ["inbox"]);
    const agent = await skapaAgentnyckel(env.DB, "cissi", "Cissis");
    expect((await rpc(agent, "tools/list")).status).toBe(200);
    await env.DB.prepare("UPDATE senders SET key_hash = NULL WHERE id = 'cissi'").run();
    expect((await rpc(agent, "tools/list")).status).toBe(401);
    expect(n).toBeTruthy();
  });
});

describe("MCP", () => {
  it("initialize och tools/list", async () => {
    const r = await rpc(ägarnyckel, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(r.status).toBe(200);
    const b = await r.json<any>();
    expect(b.result.serverInfo.name).toBe("snicksnack");
    expect(b.result.capabilities.tools).toBeDefined();
    const l = await (await rpc(ägarnyckel, "tools/list")).json<any>();
    expect(l.result.tools.map((t: any) => t.name).sort()).toEqual(["get_audio_url", "get_snack", "list_snacks", "list_targets", "search"]);
  });

  it("list_snacks: ägaren ser allt, nyast först; filter", async () => {
    const { data } = await verktyg(ägarnyckel, "list_snacks");
    expect(data.snacks.map((s: any) => s.id)).toEqual(["A2", "B1", "A1"]);
    expect(data.snacks[2]).toMatchObject({ target: "kunder", sender: "anna", title: "Styrgrupp om fjärrvärmen", words: 7, duration: 1834.2 });
    expect((await verktyg(ägarnyckel, "list_snacks", { tag: "ide" })).data.snacks.map((s: any) => s.id)).toEqual(["A2"]);
    expect((await verktyg(ägarnyckel, "list_snacks", { from: "2026-10-11", to: "2026-10-11" })).data.snacks.map((s: any) => s.id)).toEqual(["B1"]);
    expect((await verktyg(ägarnyckel, "list_snacks", { query: "taxan" })).data.snacks.map((s: any) => s.id).sort()).toEqual(["A1", "B1"]);
    expect((await verktyg(ägarnyckel, "list_snacks", { limit: 1, offset: 1 })).data).toMatchObject({ total: 3, snacks: [{ id: "B1" }] });
  });

  it("omfånget: en avsändarnyckel ser bara sina egna snack", async () => {
    expect((await verktyg(annasAgent, "list_snacks")).data.snacks.map((s: any) => s.id)).toEqual(["A2", "A1"]);
    expect((await verktyg(annasAgent, "list_snacks", { sender: "bosse" })).data.snacks).toEqual([]);
    expect((await verktyg(annasAgent, "search", { query: "taxan" })).data.hits.map((h: any) => h.id)).toEqual(["A1"]);
    const g = await verktyg(annasAgent, "get_snack", { target: "inbox", sender: "bosse", id: "B1" });
    expect(g.fel).toBe(true);
    expect(g.text).toBe("Snacket finns inte.");
    expect((await verktyg(annasAgent, "get_audio_url", { target: "inbox", sender: "bosse", id: "B1" })).fel).toBe(true);
    expect((await verktyg(bossesAgent, "list_snacks")).data.snacks.map((s: any) => s.id)).toEqual(["B1"]);
    const mål = (await verktyg(bossesAgent, "list_targets")).data;
    expect(mål.targets.map((t: any) => t.id)).toEqual(["inbox"]);
    expect(mål.senders).toBeUndefined();
  });

  it("get_snack: text med talarprefix, anteckning, sammanfattningar; words bara på begäran", async () => {
    const { data } = await verktyg(ägarnyckel, "get_snack", { target: "kunder", sender: "anna", id: "A1" });
    expect(data.text).toBe("[Anna, 0:00]: Vi börjar.\n\n[Bosse, 0:02]: Taxan höjs med tre procent.");
    expect(data.note).toBe("Kom ihåg taxan");
    expect(data.summaries[0].items[0].text).toBe("Taxan höjs.");
    expect(data.speakers).toEqual({ "0": "Anna", "1": "Bosse" });
    expect(data.has_audio).toBe(true);
    expect(data.words).toBeUndefined();
    const med = (await verktyg(ägarnyckel, "get_snack", { target: "kunder", sender: "anna", id: "A1", include: ["words"] })).data;
    expect(med.words).toHaveLength(7);
    expect(med.text).toBeUndefined();
  });

  it("search via FTS ger utdrag och referens", async () => {
    const { data } = await verktyg(ägarnyckel, "search", { query: "procent" });
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]).toMatchObject({ target: "kunder", sender: "anna", id: "A1" });
    expect(data.hits[0].snippet).toContain("«procent");
    // Prefix och sammanfattningar
    expect((await verktyg(ägarnyckel, "search", { query: "cyk" })).data.hits.map((h: any) => h.id)).toEqual(["A2"]);
    expect((await verktyg(ägarnyckel, "search", { query: 'Beslut "taxan' })).data.hits.map((h: any) => h.id)).toEqual(["A1"]);
  });

  it("list_targets för ägaren har avsändarna", async () => {
    const { data } = await verktyg(ägarnyckel, "list_targets");
    expect(data.targets.map((t: any) => t.id).sort()).toEqual(["inbox", "kunder"]);
    expect(data.senders.find((s: any) => s.id === "anna")).toMatchObject({ snacks: 2 });
  });

  it("get_audio_url: signerad länk med Range, ändrad signatur och utgången länk nekas", async () => {
    const { data } = await verktyg(annasAgent, "get_audio_url", { target: "kunder", sender: "anna", id: "A1" });
    expect(data.url).toMatch(new RegExp(`^${BAS}/ljud/`));
    expect(new Date(data.expires_at).getTime()).toBeGreaterThan(Date.now() + 3500_000);
    const väg = new URL(data.url).pathname;
    const hel = await anropa(väg);
    expect(hel.status).toBe(200);
    expect(new Uint8Array(await hel.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 0x66, 0x74, 0x79, 0x70, 5, 6]));
    const del = await anropa(väg, { headers: { Range: "bytes=2-3" } });
    expect(del.status).toBe(206);
    expect(new Uint8Array(await del.arrayBuffer())).toEqual(new Uint8Array([3, 4]));
    const [t, s] = väg.slice("/ljud/".length).split(".");
    expect((await anropa(`/ljud/${t}.${s.slice(0, -2)}AA`)).status).toBe(404);
    // Utgången: signera en länk med passerad tid
    const { signera } = await import("../src/krypto");
    const gammal = await signera("testhemlighet", `${Math.floor(Date.now() / 1000) - 10}\nkunder/anna/A1/audio.m4a`);
    expect((await anropa(`/ljud/${gammal}`)).status).toBe(410);
    // Utan ljud
    expect((await verktyg(annasAgent, "get_audio_url", { target: "inbox", sender: "anna", id: "A2" })).fel).toBe(true);
  });
});

describe("personliga sidan", () => {
  it("kräver rätt token; skapar och spärrar agentnycklar", async () => {
    expect((await anropa("/min/fel-token")).status).toBe(404);
    const { bytSidtoken } = await import("../src/agenter");
    const token = (await bytSidtoken(env.DB, "anna"))!;
    expect(token.length).toBeGreaterThan(30);
    const sida = await anropa(`/min/${token}`);
    expect(sida.status).toBe(200);
    expect(sida.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await sida.text();
    expect(html).toContain("Den här länken är din inloggning, dela den inte");
    expect(html).toContain("Annas Claude");
    expect(html).toContain("claude mcp add --transport http snicksnack https://mottagare.example/mcp");

    const ny = await anropa(`/min/${token}/agenter`, {
      method: "POST",
      headers: { Origin: BAS },
      body: new URLSearchParams({ name: "Cursor hemma" }),
    });
    expect(ny.status).toBe(200);
    const text = await ny.text();
    const nyckel = /ssk_agent_[A-Za-z0-9_-]{43}/.exec(text)![0];
    expect(text).toContain(`--header &quot;Authorization: Bearer ${nyckel}&quot;`);
    const rad = await env.DB.prepare("SELECT id, owner FROM agent_keys WHERE name = 'Cursor hemma'").first<any>();
    expect(rad.owner).toBe("anna");
    expect((await verktyg(nyckel, "list_snacks")).data.snacks.map((s: any) => s.id)).toEqual(["A2", "A1"]);

    // Bosses sida kan inte spärra Annas nyckel
    const bossesToken = (await bytSidtoken(env.DB, "bosse"))!;
    await anropa(`/min/${bossesToken}/agenter/${rad.id}/sparra`, { method: "POST", headers: { Origin: BAS } });
    expect((await rpc(nyckel, "tools/list")).status).toBe(200);
    const sp = await anropa(`/min/${token}/agenter/${rad.id}/sparra`, { method: "POST", headers: { Origin: BAS } });
    expect(sp.status).toBe(303);
    expect((await rpc(nyckel, "tools/list")).status).toBe(401);
  });
});

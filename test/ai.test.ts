import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BAS, anropa, skapaAvsändare, transkript } from "./hjalp";

let anna: string;
let bosse: string;

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

function post(väg: string, nyckel: string, kropp: unknown) {
  return anropa(väg, {
    method: "POST",
    headers: { ...auth(nyckel), "Content-Type": "application/json" },
    body: JSON.stringify(kropp),
  });
}

/** Läser en SSE-ström till en lista med data-objekt. */
async function ramar(r: Response): Promise<Record<string, unknown>[]> {
  const text = await r.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}

function möte() {
  return {
    ...transkript("M1", "Styrgrupp"),
    duration: 30,
    speakers: { "0": "Anna", "1": "Bosse" },
    note: "Fråga om budgeten.",
    text: "Vi börjar. Budgeten ser bra ut. Då kör vi.",
    words: [
      { text: "Vi", start: 0.3, end: 0.5, speaker: 0 },
      { text: "börjar.", start: 0.5, end: 0.9, speaker: 0 },
      { text: "Budgeten", start: 2.0, end: 2.4, speaker: 1 },
      { text: "ser", start: 2.4, end: 2.6, speaker: 1 },
      { text: "bra", start: 2.6, end: 2.8, speaker: 1 },
      { text: "ut.", start: 2.8, end: 3.0, speaker: 1 },
    ],
  };
}

beforeAll(async () => {
  // Migreringen lägger in testleverantören och prompterna sammanfatta-hittills (chat, live) och kort-sammanfattning.
  await env.DB.prepare(
    `INSERT INTO prompts (id, name, description, kind, live, provider_id, user_text, created_at)
     VALUES ('beslut', 'Beslut', 'Bara besluten', 'summary', 0, 'test', 'Lista besluten.', '2026-10-17'),
            ('fraga', 'Fråga', '', 'chat', 0, 'test', 'Vad sa Bosse?', '2026-10-17')`,
  ).run();
  anna = await skapaAvsändare("anna", []);
  bosse = await skapaAvsändare("bosse", []);
  await env.DB.prepare(
    `INSERT INTO sender_prompts (sender_id, prompt_id) VALUES
       ('anna', 'sammanfatta-hittills'), ('anna', 'kort-sammanfattning'), ('anna', 'fraga'), ('bosse', 'beslut')`,
  ).run();
});

describe("prompts-listan", () => {
  it("401 utan nyckel", async () => {
    expect((await anropa("/snicksnack/summarize")).status).toBe(401);
  });

  it("visar bara avsändarens prompter, med kind och live", async () => {
    const a = await (await anropa("/snicksnack/summarize", { headers: auth(anna) })).json<any>();
    expect(a.prompts.map((p: any) => p.id).sort()).toEqual(["fraga", "kort-sammanfattning", "sammanfatta-hittills"]);
    expect(a.prompts.find((p: any) => p.id === "sammanfatta-hittills")).toEqual({
      id: "sammanfatta-hittills",
      name: "Sammanfatta hittills",
      description: "Vad som sagts hittills, i några punkter.",
      kind: "chat",
      live: true,
    });
    const b = await (await anropa("/snicksnack/summarize", { headers: auth(bosse) })).json<any>();
    expect(b).toEqual({ prompts: [{ id: "beslut", name: "Beslut", description: "Bara besluten", kind: "summary", live: false }] });
  });
});

describe("summarize", () => {
  it("ger en sammanfattning i protokollets form med testleverantören", async () => {
    const r = await post("/snicksnack/summarize/kort-sammanfattning", anna, möte());
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    const b = await r.json<any>();
    expect(b.summary).toMatchObject({ kind: "custom", name: "Kort sammanfattning", prompt: "kort-sammanfattning" });
    expect(new Date(b.summary.created_at).toISOString()).toBe(b.summary.created_at);
    expect(new Set(b.summary.items.map((i: any) => i.section))).toEqual(new Set(["Översikt", "Början"]));
    for (const i of b.summary.items) {
      expect(Object.keys(i).sort()).toEqual(["at", "section", "speaker", "text"]);
      expect(typeof i.text).toBe("string");
    }
    expect(b.summary.items[0]).toMatchObject({ text: "Styrgrupp är 30 sekunder långt.", speaker: null, at: null });
    expect(b.summary.items.find((i: any) => i.section === "Början")).toMatchObject({ speaker: 0, at: 0.3 });
    expect(b.markdown).toContain("## Översikt\n\n- Styrgrupp är 30 sekunder långt.");

    const u = await env.DB.prepare("SELECT * FROM usage WHERE sender_id = 'anna' AND kind = 'summary'").first<any>();
    expect(u).toMatchObject({ prompt_id: "kort-sammanfattning", provider_id: "test", requests: 1 });
  });

  it("502 när svaret inte följer formen, efter ett nytt försök", async () => {
    const r = await post("/snicksnack/summarize/kort-sammanfattning", anna, { ...möte(), note: "[trasig]" });
    expect(r.status).toBe(502);
    expect(await r.json()).toHaveProperty("error");
  });

  it("401, 404 för okänd prompt och för prompt avsändaren inte har, 413 för stor kropp", async () => {
    expect((await post("/snicksnack/summarize/kort-sammanfattning", "ssk_fel", möte())).status).toBe(401);
    expect((await post("/snicksnack/summarize/finns-inte", anna, möte())).status).toBe(404);
    expect((await post("/snicksnack/summarize/beslut", anna, möte())).status).toBe(404);
    const stor = { ...möte(), text: "x".repeat(30_000) };
    expect((await post("/snicksnack/summarize/kort-sammanfattning", anna, stor)).status).toBe(413);
  });

  it("400 för en chattprompt och för trasig JSON", async () => {
    expect((await post("/snicksnack/summarize/sammanfatta-hittills", anna, möte())).status).toBe(400);
    const r = await anropa("/snicksnack/summarize/kort-sammanfattning", { method: "POST", headers: auth(anna), body: "{inte json" });
    expect(r.status).toBe(400);
  });
});

describe("chat", () => {
  it("strömmar content-ramar och sist done", async () => {
    const r = await post("/snicksnack/chat", anna, {
      prompt: null,
      messages: [{ role: "user", content: "Vad handlade det om?" }],
      transcript: möte(),
      live: false,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    const f = await ramar(r);
    expect(f.length).toBeGreaterThan(3);
    expect(f[f.length - 1]).toEqual({ done: true });
    const text = f.slice(0, -1).map((x) => x.content).join("");
    expect(text).toContain("Transkriptet har 6 ord och 2 talare");
    expect(text).toContain('Frågan var: "Vad handlade det om?"');
  });

  it("lägger promptens användartext sist när prompt är satt", async () => {
    const r = await post("/snicksnack/chat", anna, {
      prompt: "sammanfatta-hittills",
      messages: [],
      transcript: möte(),
      live: true,
    });
    const text = (await ramar(r)).map((x) => x.content ?? "").join("");
    expect(text).toContain('Frågan var: "Sammanfatta det som sagts hittills');
  });

  it("fel mitt i strömmen ger en error-ram och stänger", async () => {
    const r = await post("/snicksnack/chat", anna, { prompt: null, messages: [{ role: "user", content: "[fel] nu" }], transcript: möte() });
    expect(r.status).toBe(200);
    const f = await ramar(r);
    expect(f[f.length - 1]).toEqual({ error: "Testleverantören: fel mitt i strömmen" });
    expect(f.some((x) => x.done)).toBe(false);
    expect(f.some((x) => x.content)).toBe(true);
  });

  it("fel innan strömmen ger vanlig JSON", async () => {
    const r = await post("/snicksnack/chat", anna, { prompt: null, messages: [{ role: "user", content: "[fel-före]" }], transcript: möte() });
    expect(r.status).toBe(502);
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({ error: "Testleverantören: fel innan strömmen" });
  });

  it("401, 404, 400 och 413", async () => {
    const kropp = { prompt: null, messages: [{ role: "user", content: "Hej" }], transcript: möte() };
    expect((await post("/snicksnack/chat", "ssk_fel", kropp)).status).toBe(401);
    expect((await post("/snicksnack/chat", anna, { ...kropp, prompt: "beslut" })).status).toBe(404);
    // Bosse har ingen chattprompt: ingen fri chatt.
    expect((await post("/snicksnack/chat", bosse, kropp)).status).toBe(404);
    // Prompten "fraga" är inte live.
    expect((await post("/snicksnack/chat", anna, { ...kropp, prompt: "fraga", live: true })).status).toBe(400);
    expect((await post("/snicksnack/chat", anna, { ...kropp, messages: [{ role: "assistant", content: "Hej" }] })).status).toBe(400);
    expect((await post("/snicksnack/chat", anna, { ...kropp, transcript: { text: "x".repeat(30_000) } })).status).toBe(413);
  });
});

describe("well-known", () => {
  it("har summarize och chat bara när det finns prompter av den sorten", async () => {
    let b = await (await anropa("/.well-known/snicksnack")).json<any>();
    expect(b.summarize).toBe(`${BAS}/snicksnack/summarize`);
    expect(b.chat).toBe(`${BAS}/snicksnack/chat`);
    await env.DB.prepare("DELETE FROM prompts WHERE kind = 'chat'").run();
    b = await (await anropa("/.well-known/snicksnack")).json<any>();
    expect(b.chat).toBeUndefined();
    expect(b.summarize).toBeDefined();
  });
});

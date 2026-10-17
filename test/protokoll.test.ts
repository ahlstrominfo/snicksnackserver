import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BAS, anropa, paket, pngRubrik, skapaAvsändare, skapaMål, skicka, transkript } from "./hjalp";

let annasNyckel: string;
let bosseNyckel: string;

beforeAll(async () => {
  await skapaMål("inbox", "Inkorg");
  await skapaMål("umea-energi", "Umeå Energi", "Kunder");
  await skapaMål("hemligt", "Hemligt");
  annasNyckel = await skapaAvsändare("anna", ["inbox", "umea-energi"]);
  bosseNyckel = await skapaAvsändare("bosse", ["hemligt"]);
});

describe("well-known", () => {
  it("beskriver mottagaren med absoluta adresser från värden", async () => {
    const r = await anropa("/.well-known/snicksnack");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    const b = await r.json<Record<string, unknown>>();
    expect(b).toEqual({
      name: "Snicksnack-mottagare",
      version: 1,
      auth: "api-key",
      targets: `${BAS}/snicksnack/targets`,
      receive: `${BAS}/snicksnack/receive`,
      accepts: ["audio", "transcript", "text"],
      // Migreringen 0002 lägger in en chattprompt och en sammanfattningsprompt.
      summarize: `${BAS}/snicksnack/summarize`,
      chat: `${BAS}/snicksnack/chat`,
      mcp: `${BAS}/mcp`,
    });
  });

  it("tar med color och icon när de är satta", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings VALUES ('color', '#E27B48'), ('icon', '2026-10-17T10:00:00.000Z'), ('name', 'Mattias')").run();
    await env.FILER.put("_config/icon.png", pngRubrik(256, 256), { httpMetadata: { contentType: "image/png" } });
    const b = await (await anropa("/.well-known/snicksnack")).json<Record<string, unknown>>();
    expect(b.name).toBe("Mattias");
    expect(b.color).toBe("#E27B48");
    expect(b.icon).toBe(`${BAS}/icon.png?v=20261017100000000`);

    const ikon = await anropa("/icon.png?v=20261017100000000");
    expect(ikon.status).toBe(200);
    expect(ikon.headers.get("Content-Type")).toBe("image/png");
    expect(ikon.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await ikon.arrayBuffer())).toEqual(pngRubrik(256, 256));
    await env.DB.prepare("DELETE FROM settings").run();
  });
});

describe("targets", () => {
  it("401 utan nyckel eller med fel nyckel", async () => {
    for (const huvud of [undefined, "Bearer fel", "Basic abc"]) {
      const r = await anropa("/snicksnack/targets", { headers: huvud ? { Authorization: huvud } : {} });
      expect(r.status).toBe(401);
      expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    }
  });

  it("visar bara målen avsändaren tilldelats", async () => {
    const a = await (await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${annasNyckel}` } })).json();
    expect(a).toEqual({
      targets: [
        { id: "inbox", name: "Inkorg" },
        { id: "umea-energi", name: "Umeå Energi", group: "Kunder" },
      ],
    });
    const b = await (await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${bosseNyckel}` } })).json();
    expect(b).toEqual({ targets: [{ id: "hemligt", name: "Hemligt" }] });
  });
});

describe("receive", () => {
  it("401 med fel nyckel", async () => {
    const r = await skicka("inbox", "ssk_fel", paket(transkript("x", "x")), "x");
    expect(r.status).toBe(401);
  });

  it("404 för okänt mål och för mål avsändaren inte har", async () => {
    expect((await skicka("finns-inte", annasNyckel, paket(transkript("x", "x")), "x")).status).toBe(404);
    const r = await skicka("hemligt", annasNyckel, paket(transkript("x", "x")), "x");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Okänt mål" });
  });

  it("sparar delarna i R2 och indexet, och svarar med id och url", async () => {
    const ljud = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await skicka(
      "umea-energi",
      annasNyckel,
      paket(transkript("20261010T093012", "Styrgrupp"), { text: "# Styrgrupp\n\nVi börjar.", ljud }),
      "20261010T093012",
    );
    expect(r.status).toBe(201);
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({
      id: "umea-energi/anna/20261010T093012",
      url: `${BAS}/admin/snack/umea-energi/anna/20261010T093012`,
    });

    const prefix = "umea-energi/anna/20261010T093012/";
    const t = await env.FILER.get(prefix + "transcript.json");
    expect((await t!.json<{ title: string }>()).title).toBe("Styrgrupp");
    expect(await (await env.FILER.get(prefix + "text.md"))!.text()).toBe("# Styrgrupp\n\nVi börjar.");
    const a = await env.FILER.get(prefix + "audio.m4a");
    expect(new Uint8Array(await a!.arrayBuffer())).toEqual(ljud);
    expect(a!.httpMetadata?.contentType).toBe("audio/mp4");

    const rad = await env.DB.prepare("SELECT * FROM snacks WHERE snack_id = ?").bind("20261010T093012").first<any>();
    expect(rad).toMatchObject({
      target_id: "umea-energi",
      sender_id: "anna",
      title: "Styrgrupp",
      recorded_at: "2026-10-10T09:30:12+02:00",
      duration: 1834.2,
      language: "sv",
      sends: 1,
    });
    expect(JSON.parse(rad.tags)).toEqual(["styrgrupp", "fjärrvärme"]);
    expect(JSON.parse(rad.files)).toEqual(["audio.m4a", "text.md", "transcript.json"]);
  });

  it("omsändning skriver över i stället för att dubblera", async () => {
    const första = await skicka("inbox", annasNyckel, paket(transkript("S1", "Gammal titel"), { text: "gammal", ljud: new Uint8Array([1]) }), "S1");
    expect(första.status).toBe(201);
    const andra = await skicka(
      "inbox",
      annasNyckel,
      paket(transkript("S1", "Ny titel"), { text: "ny", ljud: new Uint8Array([9, 9]), ljudtyp: "audio/wav", ljudnamn: "S1.wav" }),
      "S1",
    );
    expect(andra.status).toBe(200);
    expect(await andra.json()).toMatchObject({ id: "inbox/anna/S1" });

    const lista = await env.FILER.list({ prefix: "inbox/anna/S1/" });
    expect(lista.objects.map((o) => o.key).sort()).toEqual([
      "inbox/anna/S1/audio.wav",
      "inbox/anna/S1/text.md",
      "inbox/anna/S1/transcript.json",
    ]);
    expect(await (await env.FILER.get("inbox/anna/S1/text.md"))!.text()).toBe("ny");

    const { results } = await env.DB.prepare("SELECT title, sends, files FROM snacks WHERE snack_id = 'S1'").all<any>();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Ny titel");
    expect(results[0].sends).toBe(2);
  });

  it("tål att text och ljud saknas och tar id från transcript utan Idempotency-Key", async () => {
    const r = await skicka("inbox", annasNyckel, paket(transkript("bara-transkript", "Kort")));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: "inbox/anna/bara-transkript" });
  });

  it("413 när kroppen är för stor", async () => {
    const r = await skicka("inbox", annasNyckel, paket(transkript("stor", "Stor"), { ljud: new Uint8Array(30_000) }), "stor");
    expect(r.status).toBe(413);
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await env.FILER.head("inbox/anna/stor/transcript.json")).toBeNull();
  });

  it("400 för trasig transcript", async () => {
    const f = new FormData();
    f.append("transcript", new File(["{inte json"], "transcript.json", { type: "application/json" }));
    expect((await skicka("inbox", annasNyckel, f, "trasig")).status).toBe(400);
  });

  it("sparar bara delarna i accepts", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO settings VALUES ('accepts', '["transcript","text"]')`).run();
    const r = await skicka("inbox", annasNyckel, paket(transkript("utan-ljud", "U"), { text: "t", ljud: new Uint8Array([1]) }), "utan-ljud");
    expect(r.status).toBe(201);
    expect(await env.FILER.head("inbox/anna/utan-ljud/audio.m4a")).toBeNull();
    expect(await env.FILER.head("inbox/anna/utan-ljud/text.md")).not.toBeNull();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'accepts'").run();
  });

  it("en spärrad nyckel ger 401", async () => {
    const nyckel = await skapaAvsändare("cissi", ["inbox"]);
    expect((await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${nyckel}` } })).status).toBe(200);
    await env.DB.prepare("UPDATE senders SET key_hash = NULL WHERE id = 'cissi'").run();
    expect((await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${nyckel}` } })).status).toBe(401);
  });
});

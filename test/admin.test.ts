import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BAS, anropa, paket, pngRubrik, skapaAvsändare, skapaMål, skicka, transkript } from "./hjalp";

async function loggaIn(lösen = "testlösen"): Promise<Response> {
  return anropa("/admin/login", { method: "POST", headers: { Origin: BAS }, body: new URLSearchParams({ password: lösen }) });
}

async function cookie(): Promise<string> {
  const r = await loggaIn();
  return r.headers.get("Set-Cookie")!.split(";")[0];
}

function post(väg: string, kaka: string, kropp: URLSearchParams | FormData) {
  return anropa(väg, { method: "POST", headers: { Cookie: kaka, Origin: BAS }, body: kropp });
}

describe("admin-inloggning", () => {
  it("skickar till inloggningen utan cookie", async () => {
    const r = await anropa("/admin/avsandare");
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/admin/login?next=%2Fadmin%2Favsandare");
  });

  it("fel lösenord ger 401 och ingen cookie", async () => {
    const r = await loggaIn("fel");
    expect(r.status).toBe(401);
    expect(r.headers.get("Set-Cookie")).toBeNull();
  });

  it("rätt lösenord ger en signerad cookie som släpper in", async () => {
    const r = await loggaIn();
    expect(r.status).toBe(303);
    const set = r.headers.get("Set-Cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    const kaka = set.split(";")[0];
    const sida = await anropa("/admin/avsandare", { headers: { Cookie: kaka } });
    expect(sida.status).toBe(200);
    expect(await sida.text()).toContain("Ny avsändare");
  });

  it("en ändrad cookie godtas inte", async () => {
    const kaka = await cookie();
    const [namn, värde] = kaka.split("=");
    const [utgår, sig] = värde.split(".");
    const förfalskad = `${namn}=${Number(utgår) + 1000}.${sig}`;
    expect((await anropa("/admin/avsandare", { headers: { Cookie: förfalskad } })).status).toBe(303);
  });

  it("nekar formulär från annat ursprung", async () => {
    const kaka = await cookie();
    const r = await anropa("/admin/mal", {
      method: "POST",
      headers: { Cookie: kaka, Origin: "https://ond.example" },
      body: new URLSearchParams({ name: "X" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("admin-flödet", () => {
  it("skapar mål och avsändare; nyckeln och QR-koden fungerar mot protokollet", async () => {
    const kaka = await cookie();
    expect((await post("/admin/mal", kaka, new URLSearchParams({ name: "Inkorg", id: "inbox" }))).status).toBe(303);
    expect((await post("/admin/mal", kaka, new URLSearchParams({ name: "Umeå Energi", group: "Kunder" }))).status).toBe(303);
    const mål = await env.DB.prepare("SELECT id FROM targets ORDER BY id").all<{ id: string }>();
    expect(mål.results.map((m) => m.id)).toEqual(["inbox", "umea-energi"]);

    const f = new URLSearchParams({ name: "Åsa Öberg" });
    f.append("targets", "umea-energi");
    const r = await post("/admin/avsandare", kaka, f);
    expect(r.status).toBe(200);
    const sida = await r.text();
    expect(sida).toContain("<svg");
    const nyckel = /ssk_[A-Za-z0-9_-]{43}/.exec(sida)![0];
    expect(sida).toContain(`snicksnack://receiver?url=${BAS}&amp;key=${nyckel}`);

    // Bara hashen sparas
    const rad = await env.DB.prepare("SELECT id, key_hash FROM senders WHERE name = 'Åsa Öberg'").first<any>();
    expect(rad.id).toBe("asa-oberg");
    expect(rad.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sida).not.toContain(rad.key_hash);

    const t = await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${nyckel}` } });
    expect(await t.json()).toEqual({ targets: [{ id: "umea-energi", name: "Umeå Energi", group: "Kunder" }] });

    // Spärra
    expect((await post("/admin/avsandare/asa-oberg/sparra", kaka, new URLSearchParams())).status).toBe(303);
    expect((await anropa("/snicksnack/targets", { headers: { Authorization: `Bearer ${nyckel}` } })).status).toBe(401);
  });

  it("visar mottagna snack och laddar ner filerna", async () => {
    await skapaMål("lista", "Lista");
    const nyckel = await skapaAvsändare("dora", ["lista"]);
    const svar = await skicka("lista", nyckel, paket(transkript("L1", "Veckomöte <b>"), { text: "# Veckomöte\n\nHej", ljud: new Uint8Array([7, 7, 7]) }), "L1");
    const { url } = await svar.json<{ url: string }>();
    const kaka = await cookie();

    const lista = await (await anropa("/admin/snack?mal=lista", { headers: { Cookie: kaka } })).text();
    expect(lista).toContain("Veckomöte &lt;b&gt;");
    expect(lista).toContain("30 min 34 s");

    const sida = await anropa(url.slice(BAS.length), { headers: { Cookie: kaka } });
    expect(sida.status).toBe(200);
    const text = await sida.text();
    expect(text).toContain("# Veckomöte");
    expect(text).toContain("/admin/fil/lista/dora/L1/audio.m4a");

    const ljud = await anropa("/admin/fil/lista/dora/L1/audio.m4a?ladda=1", { headers: { Cookie: kaka } });
    expect(ljud.status).toBe(200);
    expect(ljud.headers.get("Content-Disposition")).toContain("attachment");
    expect(new Uint8Array(await ljud.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));

    const del = await anropa("/admin/fil/lista/dora/L1/audio.m4a", { headers: { Cookie: kaka, Range: "bytes=1-" } });
    expect(del.status).toBe(206);
    expect(del.headers.get("Content-Range")).toBe("bytes 1-2/3");

    expect((await anropa("/admin/fil/lista/dora/L1/annat.txt", { headers: { Cookie: kaka } })).status).toBe(404);
  });

  it("inställningar: namn, färg och logga syns i well-known", async () => {
    const kaka = await cookie();
    const f = new FormData();
    f.append("name", "Mattias mottagare");
    f.append("color", "#e27b48");
    f.append("accepts", "transcript");
    f.append("accepts", "text");
    f.append("icon", new File([pngRubrik(512, 512)], "logga.png", { type: "image/png" }));
    expect((await post("/admin/installningar", kaka, f)).status).toBe(303);

    const b = await (await anropa("/.well-known/snicksnack")).json<Record<string, unknown>>();
    expect(b).toMatchObject({ name: "Mattias mottagare", color: "#E27B48", accepts: ["transcript", "text"] });

    expect(b.icon).toMatch(new RegExp(`^${BAS}/icon\\.png\\?v=\\d+$`));
    expect((await anropa(new URL(b.icon as string).pathname + new URL(b.icon as string).search)).status).toBe(200);

    const fel = new FormData();
    fel.append("name", "X");
    fel.append("color", "#000000");
    fel.append("accepts", "text");
    fel.append("icon", new File([pngRubrik(300, 200)], "fel.png", { type: "image/png" }));
    const r = await post("/admin/installningar", kaka, fel);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("kvadratisk");
  });
});

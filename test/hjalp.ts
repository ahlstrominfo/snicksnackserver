// Hjälp för testerna: skapa mål och avsändare direkt i D1 och bygga anrop.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { nyNyckel, sha256Hex } from "../src/krypto";

export const BAS = "https://mottagare.example";

let nästaIp = 1;

/** Ett anrop till Workern. Varje anrop får en egen IP-adress (CF-Connecting-IP) om testet inte anger en, så att
 * rate limits per IP inte slår till mellan testerna. */
export function anropa(väg: string, init?: RequestInit): Promise<Response> {
  const huvuden = new Headers(init?.headers);
  if (!huvuden.has("CF-Connecting-IP")) huvuden.set("CF-Connecting-IP", `10.0.${Math.floor(nästaIp / 250) % 250}.${(nästaIp++ % 250) + 1}`);
  return (exports as any).default.fetch(new Request(BAS + väg, { redirect: "manual", ...init, headers: huvuden }));
}

export async function skapaMål(id: string, namn: string, grupp: string | null = null) {
  await env.DB.prepare("INSERT OR REPLACE INTO targets (id, name, grp, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, namn, grupp, new Date().toISOString())
    .run();
}

export async function skapaAvsändare(id: string, mål: string[]): Promise<string> {
  const nyckel = nyNyckel();
  await env.DB.prepare("INSERT INTO senders (id, name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, id.toUpperCase(), await sha256Hex(nyckel), nyckel.slice(-4), new Date().toISOString())
    .run();
  for (const m of mål) {
    await env.DB.prepare("INSERT INTO sender_targets (sender_id, target_id) VALUES (?, ?)").bind(id, m).run();
  }
  return nyckel;
}

export function transkript(id: string, titel: string) {
  return {
    format: "snicksnack-transcript",
    version: 1,
    id,
    title: titel,
    recorded_at: "2026-10-10T09:30:12+02:00",
    duration: 1834.2,
    language: "sv",
    tags: ["styrgrupp", "fjärrvärme"],
    note: null,
    quick_note: false,
    speakers: { "0": "Anna" },
    speakers_hidden: false,
    text: "Vi börjar.",
    words: [
      { text: "Vi", start: 0.32, end: 0.48, speaker: 0 },
      { text: "börjar.", start: 0.51, end: 0.9, speaker: 0 },
    ],
    summaries: [],
    parts: [],
    app: { name: "Snicksnack", version: "test", model: "test" },
  };
}

export function paket(
  t: object | null,
  opt: { text?: string; ljud?: Uint8Array; ljudtyp?: string; ljudnamn?: string } = {},
): FormData {
  const f = new FormData();
  if (t) f.append("transcript", new File([JSON.stringify(t)], "transcript.json", { type: "application/json" }));
  if (opt.text !== undefined) f.append("text", new File([opt.text], "Styrgrupp.md", { type: "text/markdown; charset=utf-8" }));
  if (opt.ljud) {
    f.append("audio", new File([opt.ljud], opt.ljudnamn ?? "x.m4a", { type: opt.ljudtyp ?? "audio/mp4" }));
  }
  return f;
}

export function skicka(mål: string, nyckel: string, kropp: FormData, idempotens?: string) {
  const huvuden: Record<string, string> = { Authorization: `Bearer ${nyckel}` };
  if (idempotens) huvuden["Idempotency-Key"] = idempotens;
  return anropa(`/snicksnack/receive/${encodeURIComponent(mål)}`, { method: "POST", headers: huvuden, body: kropp });
}

/** En minimal giltig PNG-rubrik med angiven storlek (bara signatur och IHDR; räcker för kontrollen). */
export function pngRubrik(bredd: number, höjd: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, bredd);
  v.setUint32(20, höjd);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Början av en m4a (MPEG-4: "ftyp" i byte 4–8) följd av bytes. */
export function m4a(...bytes: number[]): Uint8Array {
  return new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypM4A "), ...bytes]);
}

/** Början av en wav (RIFF…WAVE) följd av bytes. */
export function wav(...bytes: number[]): Uint8Array {
  return new Uint8Array([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVEfmt "), ...bytes]);
}

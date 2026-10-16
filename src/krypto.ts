// Nycklar, hashning och signerade cookies.

const kodare = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function frånBase64url(s: string): Uint8Array | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", kodare.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** En ny avsändarnyckel: "ssk_" och 32 slumpade byte (base64url). */
export function nyNyckel(): string {
  return "ssk_" + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmacNyckel(lösenord: string): Promise<CryptoKey> {
  // Nyckeln härleds ur lösenordet: byts lösenordet blir alla gamla inloggningar ogiltiga.
  return crypto.subtle.importKey(
    "raw",
    kodare.encode("snicksnack-mottagare/admin/" + lösenord),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export const SESSION_DAGAR = 30;

export async function skapaSession(lösenord: string): Promise<string> {
  const utgår = String(Date.now() + SESSION_DAGAR * 86400_000);
  const sig = await crypto.subtle.sign("HMAC", await hmacNyckel(lösenord), kodare.encode(utgår));
  return `${utgår}.${base64url(new Uint8Array(sig))}`;
}

export async function giltigSession(lösenord: string, värde: string | undefined): Promise<boolean> {
  if (!värde) return false;
  const [utgår, sig] = värde.split(".");
  if (!utgår || !sig || !/^\d+$/.test(utgår) || Number(utgår) < Date.now()) return false;
  const bytes = frånBase64url(sig);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await hmacNyckel(lösenord), bytes, kodare.encode(utgår));
}

/** Jämför lösenord utan att läcka tid: båda hashas och jämförs i konstant tid. */
export async function rättLösenord(rätt: string, givet: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [rätt, givet].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", kodare.encode(s)))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

export function läsCookie(req: Request, namn: string): string | undefined {
  const huvud = req.headers.get("Cookie") ?? "";
  for (const del of huvud.split(";")) {
    const i = del.indexOf("=");
    if (i > 0 && del.slice(0, i).trim() === namn) return del.slice(i + 1).trim();
  }
  return undefined;
}

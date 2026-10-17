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

// ---------- API-nycklar till AI-leverantörer ----------
// Krypteras med AES-GCM. Nyckeln härleds med HKDF ur secret KEY_SECRET; utan den går det inte att spara
// eller använda nycklar. Formatet i D1: "v1.<iv>.<chiffer>" (base64url).

async function aesNyckel(hemlighet: string): Promise<CryptoKey> {
  const bas = await crypto.subtle.importKey("raw", kodare.encode(hemlighet), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: kodare.encode("snicksnack-mottagare"), info: kodare.encode("api-nycklar/v1") },
    bas,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function kryptera(hemlighet: string, klartext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesNyckel(hemlighet), kodare.encode(klartext));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
}

export async function dekryptera(hemlighet: string, värde: string): Promise<string> {
  const [v, iv, ct] = värde.split(".");
  const ivb = iv ? frånBase64url(iv) : null;
  const ctb = ct ? frånBase64url(ct) : null;
  if (v !== "v1" || !ivb || !ctb) throw new Error("Okänt format på den sparade nyckeln");
  const klar = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivb }, await aesNyckel(hemlighet), ctb);
  return new TextDecoder().decode(klar);
}

/** Visas i admin i stället för nyckeln: "sk-ant-…abcd". */
export function maskera(nyckel: string): string {
  return nyckel.length <= 12 ? "…" + nyckel.slice(-2) : `${nyckel.slice(0, 7)}…${nyckel.slice(-4)}`;
}

// ---------- Signerade länkar (ljudet för agenter) ----------

async function länknyckel(hemlighet: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", kodare.encode("snicksnack-mottagare/ljudlankar/" + hemlighet), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** "<base64url(text)>.<base64url(hmac)>" */
export async function signera(hemlighet: string, text: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await länknyckel(hemlighet), kodare.encode(text));
  return `${base64url(kodare.encode(text))}.${base64url(new Uint8Array(sig))}`;
}

/** Texten om signaturen stämmer, annars null. */
export async function verifiera(hemlighet: string, token: string): Promise<string | null> {
  const [t, s] = token.split(".");
  const tb = t ? frånBase64url(t) : null;
  const sb = s ? frånBase64url(s) : null;
  if (!tb || !sb) return null;
  const ok = await crypto.subtle.verify("HMAC", await länknyckel(hemlighet), sb, tb);
  return ok ? new TextDecoder().decode(tb) : null;
}

/** En lång slumpad token för länkar (personliga sidan). */
export function slumptoken(byte = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byte)));
}

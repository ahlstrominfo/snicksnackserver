// Liten mall för HTML: värden escapas om de inte uttryckligen är Raw.

export class Raw {
  constructor(readonly s: string) {}
  toString() {
    return this.s;
  }
}

export const raw = (s: string) => new Raw(s);

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function värde(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(värde).join("");
  return esc(String(v));
}

export function html(strängar: TemplateStringsArray, ...värden: unknown[]): Raw {
  let ut = strängar[0];
  for (let i = 0; i < värden.length; i++) ut += värde(värden[i]) + strängar[i + 1];
  return new Raw(ut);
}

export interface Sidval {
  /** form-action 'self' i CSP. Av för OAuth-inloggningen: formuläret skickas vidare (redirect) till klientens adress,
   * och Chrome tillämpar form-action också på den. */
  formAction?: boolean;
}

/** Säkerhetshuvudena på alla HTML-svar. Skript bara med nonce; stil inline (style-attribut används i mallarna).
 * HSTS sätts i Cloudflare-zonen, inte här (se SECURITY.md). */
export function säkerhetshuvuden(nonce: string | null, val: Sidval = {}): Record<string, string> {
  const csp = [
    "default-src 'none'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(val.formAction === false ? [] : ["form-action 'self'"]),
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/** Huvuden för filer som visas från R2 (snackens filer, ljudlänkar): aldrig som sida eller skript. */
export const FILHUVUDEN = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };

export function htmlSvar(kropp: Raw, status = 200, huvuden: Record<string, string> = {}, val: Sidval = {}): Response {
  // Mallarna skriver <script> bokstavligt; allt som escapas kan inte innehålla "<", så bara våra egna får nonce.
  const nonce = kropp.s.includes("<script>") ? base64(crypto.getRandomValues(new Uint8Array(16))) : null;
  const text = nonce ? kropp.s.replaceAll("<script>", `<script nonce="${nonce}">`) : kropp.s;
  return new Response("<!doctype html>" + text, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...säkerhetshuvuden(nonce, val), ...huvuden },
  });
}

function base64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

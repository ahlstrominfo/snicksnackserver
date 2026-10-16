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

export function htmlSvar(kropp: Raw, status = 200, huvuden: Record<string, string> = {}): Response {
  return new Response("<!doctype html>" + kropp.s, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...huvuden },
  });
}

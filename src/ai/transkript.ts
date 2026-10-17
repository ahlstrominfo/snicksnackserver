// Transkriptet som text till modellen, systemprompten och sammanfattningens form.

export interface Ord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  speaker?: unknown;
}

export interface Transkript {
  id?: unknown;
  title?: unknown;
  recorded_at?: unknown;
  duration?: unknown;
  language?: unknown;
  tags?: unknown;
  note?: unknown;
  speakers?: unknown;
  text?: unknown;
  words?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const tal = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

/** Talar-id → namn; id utan namn blir "Talare N" (N = id + 1, som i appen). */
export function talarnamn(t: Transkript, id: number): string {
  const namn = t.speakers && typeof t.speakers === "object" ? (t.speakers as Record<string, unknown>)[String(id)] : null;
  return typeof namn === "string" && namn.trim() ? namn.trim() : `Talare ${id + 1}`;
}

export function talarIdn(t: Transkript): Set<number> {
  const idn = new Set<number>();
  if (t.speakers && typeof t.speakers === "object") {
    for (const k of Object.keys(t.speakers)) if (/^\d+$/.test(k)) idn.add(Number(k));
  }
  if (Array.isArray(t.words)) for (const o of t.words as Ord[]) if (Number.isInteger(o?.speaker)) idn.add(o.speaker as number);
  return idn;
}

function mmss(sek: number): string {
  const s = Math.floor(sek);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Texten med talarprefix när talaren byts (som Lyssnaren gör), och ett nytt prefix minst varje minut så att
 * modellen kan ange tider. Chatten får "[Anna, 1:23]:", sammanfattningen "[Anna (talare 0), 83 s]:" så att
 * speaker och at går att fylla i. Utan ordtider används text.
 */
export function transkriptText(t: Transkript, läge: "chatt" | "sammanfattning"): string {
  const ord = Array.isArray(t.words) ? (t.words as Ord[]).filter((o) => typeof o?.text === "string" && o.text) : [];
  if (!ord.length) return str(t.text).trim();
  const harTalare = ord.some((o) => Number.isInteger(o.speaker));
  const rader: string[] = [];
  let rad = "";
  let talare: number | null | undefined = undefined;
  let blockStart = -Infinity;
  for (const o of ord) {
    const sp = Number.isInteger(o.speaker) ? (o.speaker as number) : null;
    const start = tal(o.start) ?? blockStart;
    if (sp !== talare || start - blockStart >= 60) {
      if (rad) rader.push(rad.trim());
      const delar: string[] = [];
      if (harTalare) {
        const namn = sp === null ? "okänd talare" : talarnamn(t, sp);
        delar.push(läge === "sammanfattning" && sp !== null ? `${namn} (talare ${sp})` : namn);
      }
      if (tal(o.start) !== null) delar.push(läge === "sammanfattning" ? `${Math.round(start * 10) / 10} s` : mmss(start));
      rad = delar.length ? `[${delar.join(", ")}]:` : "";
      talare = sp;
      blockStart = start;
    }
    rad += " " + (o.text as string);
  }
  if (rad) rader.push(rad.trim());
  return rader.join("\n\n");
}

export const STANDARDSYSTEM =
  "Du hjälper till med ett samtal som spelats in och transkriberats automatiskt på en telefon (appen Snicksnack). " +
  "Transkriptet kan innehålla hörfel, och talarna kan vara fel uppdelade eller sakna namn. " +
  "Svara på samma språk som samtalet om inte användaren ber om något annat. Var konkret och kortfattad.";

/** Systemprompten: systemtexten, uppgifter om snacket, anteckningen och hela transkriptet. */
export function systemprompt(
  t: Transkript,
  systemtext: string,
  opt: { live: boolean; läge: "chatt" | "sammanfattning" },
): string {
  const delar = [systemtext.trim() || STANDARDSYSTEM];
  if (opt.live) {
    delar.push(
      "Mötet pågår fortfarande. Transkriptet nedan är det som sagts hittills; det senaste står sist och kan vara ofullständigt.",
    );
  }
  const fakta: string[] = [];
  if (str(t.title)) fakta.push(`Titel: ${str(t.title)}`);
  if (str(t.recorded_at)) fakta.push(`Inspelat: ${str(t.recorded_at)}`);
  const längd = tal(t.duration);
  if (längd !== null) fakta.push(`Längd: ${mmss(längd)} (${Math.round(längd)} s)`);
  if (str(t.language)) fakta.push(`Språk: ${str(t.language)}`);
  const taggar = Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : [];
  if (taggar.length) fakta.push(`Taggar: ${taggar.join(", ")}`);
  if (fakta.length) delar.push(fakta.join("\n"));
  if (str(t.note).trim()) delar.push(`Användarens anteckning:\n---\n${str(t.note).trim()}\n---`);
  const text = transkriptText(t, opt.läge);
  delar.push(text ? `Transkriptet:\n---\n${text}\n---` : "Transkriptet är tomt än så länge.");
  return delar.join("\n\n");
}

// ---------- Sammanfattningens form ----------

export const SAMMANFATTNINGSSCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                speaker: { anyOf: [{ type: "integer" }, { type: "null" }] },
                at: { anyOf: [{ type: "number" }, { type: "null" }] },
              },
              required: ["text", "speaker", "at"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
} as const;

export const FORMINSTRUKTION =
  'Svara bara med JSON i formen {"sections":[{"title":"Rubrik","items":[{"text":"…","speaker":0,"at":83.5}]}]}. ' +
  "Varje avsnitt har en kort rubrik och en eller flera punkter. speaker är talarens nummer (talare N i transkriptet) " +
  "när punkten kommer från en viss talare, annars null. at är sekunden i inspelningen där punkten har sin källa, " +
  "annars null. Skriv punkterna på samtalets språk.";

export interface Punkt {
  section: string;
  text: string;
  speaker: number | null;
  at: number | null;
}

/** Validerar modellens svar. null om det inte följer formen (då görs anropet om en gång). */
export function tolkaSammanfattning(värde: unknown, talare: Set<number>, längd: number | null): Punkt[] | null {
  if (!värde || typeof värde !== "object" || !Array.isArray((värde as { sections?: unknown }).sections)) return null;
  const punkter: Punkt[] = [];
  for (const avsnitt of (värde as { sections: unknown[] }).sections) {
    if (!avsnitt || typeof avsnitt !== "object") return null;
    const { title, items } = avsnitt as { title?: unknown; items?: unknown };
    if (typeof title !== "string" || !title.trim() || !Array.isArray(items)) return null;
    for (const p of items) {
      if (!p || typeof p !== "object") return null;
      const { text, speaker, at } = p as { text?: unknown; speaker?: unknown; at?: unknown };
      if (typeof text !== "string" || !text.trim()) return null;
      // Talare och tid som inte finns i snacket blir null i stället för att fälla svaret.
      const sp = Number.isInteger(speaker) && talare.has(speaker as number) ? (speaker as number) : null;
      const t = typeof at === "number" && isFinite(at) && at >= 0 && (längd === null || at <= längd + 5) ? at : null;
      punkter.push({ section: title.trim(), text: text.trim(), speaker: sp, at: t });
    }
  }
  return punkter.length ? punkter : null;
}

export function markdown(punkter: Punkt[]): string {
  const ut: string[] = [];
  let avsnitt = "";
  for (const p of punkter) {
    if (p.section !== avsnitt) {
      if (ut.length) ut.push("");
      ut.push(`## ${p.section}`, "");
      avsnitt = p.section;
    }
    ut.push(`- ${p.text}`);
  }
  return ut.join("\n") + "\n";
}

/** Tolkar JSON ur en modells text, också inlindad i ```json … ```. */
export function läsJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

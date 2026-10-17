// Admin på /admin: inställningar, mål, avsändare och mottagna snack. Enkel HTML direkt från Workern;
// utseendet (färger, typsnitt, loggan) ligger i utseende.ts.

import qrcode from "qrcode-generator";
import {
  DELAR,
  MÅL_ID,
  allaAvsändare,
  allaMål,
  hämtaInställningar,
  nu,
  slug,
  sättInställning,
  type Del,
  type Inställningar,
  type Mål,
  type SnackRad,
} from "./db";
import { html, htmlSvar, raw, type Raw } from "./html";
import { giltigSession, läsCookie, nyNyckel, rättLösenord, sha256Hex, skapaSession, SESSION_DAGAR } from "./krypto";
import { IKON_NYCKEL, ikonversion } from "./protokoll";
import { adminAi, allaPrompter, promptVal, sättPrompterFörAvsändare } from "./admin-ai";
import { FAVICON, fältrad, logga, rubrik, SKRIPT, STIL, tomt, valgrupp, växel } from "./utseende";

const COOKIE = "snicksnack_admin";
const STANDARDFÄRG = "#E27B48";
const FILNAMN = ["transcript.json", "text.md", "audio.m4a", "audio.wav"];
const STÖRSTA_IKON = 2 * 1024 * 1024; // appen hämtar högst 2 MB

const DELNAMN: Record<Del, string> = { audio: "Ljud", transcript: "Transkript (transcript.json)", text: "Text (markdown)" };

export class EjFunnen extends Error {}

// ---------- Ingång ----------

export async function admin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const väg = url.pathname.replace(/\/+$/, "") || "/admin";
  const lösen = env.ADMIN_PASSWORD;

  if (!lösen) {
    return htmlSvar(
      sida(
        null,
        "Lösenord saknas",
        html`${rubrik("Lösenord saknas", "Sätt ett lösenord för admin först.")}
          <div class="kort">
            <p><code>npx wrangler secret put ADMIN_PASSWORD</code></p>
            <p class="tips">Lokalt med <code>wrangler dev</code>: lägg <code>ADMIN_PASSWORD=…</code> i <code>.dev.vars</code>.</p>
          </div>`,
      ),
      503,
    );
  }

  // Formulär får bara postas från den egna sidan (skydd mot CSRF utöver SameSite på cookien).
  if (req.method === "POST") {
    const ursprung = req.headers.get("Origin");
    if (ursprung && ursprung !== url.origin) return htmlSvar(sida(null, "Nekad", rubrik("Nekad", "Formuläret kom från en annan sida.")), 403);
  }

  if (väg === "/admin/login") return req.method === "POST" ? loggaIn(req, env, url) : loginSida(url);
  if (väg === "/admin/logout" && req.method === "POST") {
    return omdirigera("/admin/login", { "Set-Cookie": cookie(url, "", 0) });
  }

  if (!(await giltigSession(lösen, läsCookie(req, COOKIE)))) {
    if (req.method === "GET") return omdirigera(`/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return htmlSvar(sida(null, "Inte inloggad", html`${rubrik("Inte inloggad")}<p><a class="knapp" href="/admin/login">Logga in</a></p>`), 401);
  }

  let delar: string[];
  try {
    delar = väg.split("/").slice(2).map(decodeURIComponent);
  } catch {
    return inteFunnen(env);
  }
  const s = await hämtaInställningar(env.DB);
  const post = req.method === "POST";

  try {
    switch (delar[0]) {
      case undefined:
        return await omdirigera("/admin/snack");
      case "snack":
        if (delar.length === 1 && !post) return await snackLista(env, s, url);
        if (delar.length === 4 && !post) return await snackSida(env, s, delar[1], delar[2], delar[3], url);
        if (delar.length === 5 && delar[4] === "ta-bort" && post) return await taBortSnack(env, delar[1], delar[2], delar[3]);
        break;
      case "fil":
        if (delar.length === 5 && !post) return await fil(req, env, delar[1], delar[2], delar[3], delar[4], url);
        break;
      case "mal":
        if (delar.length === 1) return await (post ? skapaMål(req, env, s) : målSida(env, s, url));
        if (delar.length === 2 && post) return await ändraMål(req, env, delar[1]);
        if (delar.length === 3 && delar[2] === "ta-bort" && post) return await taBortMål(env, delar[1]);
        break;
      case "avsandare":
        if (delar.length === 1) return await (post ? skapaAvsändare(req, env, s, url) : avsändarSida(env, s, url));
        if (delar.length === 2 && post) return await ändraAvsändare(req, env, delar[1]);
        if (delar.length === 3 && post) {
          if (delar[2] === "sparra") return await spärra(env, delar[1]);
          if (delar[2] === "ny-nyckel") return await bytNyckel(env, s, delar[1], url);
          if (delar[2] === "ta-bort") return await taBortAvsändare(env, delar[1]);
        }
        break;
      case "prompter":
      case "leverantorer": {
        const svar = await adminAi(req, env, s, delar, url);
        if (svar) return svar;
        break;
      }
      case "installningar":
        if (delar.length === 1) return await (post ? sparaInställningar(req, env, s) : inställningsSida(env, s, url));
        break;
    }
  } catch (e) {
    if (e instanceof EjFunnen) return inteFunnen(env, s);
    throw e;
  }
  return inteFunnen(env, s);
}

// ---------- Hjälp ----------

function cookie(url: URL, värde: string, maxAge: number): string {
  const säker = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${värde}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${säker}`;
}

export function omdirigera(till: string, huvuden: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: till, "Cache-Control": "no-store", ...huvuden } });
}

export const medMeddelande = (väg: string, text: string) => omdirigera(`${väg}?meddelande=${encodeURIComponent(text)}`);

async function inteFunnen(env: Env, s?: Inställningar): Promise<Response> {
  return htmlSvar(sida(s ?? (await hämtaInställningar(env.DB)), "Finns inte", html`${rubrik("Finns inte")}${tomt("Här finns inget. Kanske är det borttaget?")}`), 404);
}

const vägTill = (...delar: string[]) => "/" + delar.map(encodeURIComponent).join("/");

function längd(sek: number | null): string {
  if (sek === null || !isFinite(sek)) return "–";
  const s = Math.round(sek);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

/** recorded_at visas i inspelningens egen tid: "2026-10-10 09:30". */
function inspelad(iso: string | null): string {
  const m = iso && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : (iso ?? "–");
}

/** recorded_at som "lör 10 okt. 09:30" (med år om det inte är i år). */
function inspeladLång(iso: string | null): string {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (!m) return inspelad(iso);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const år = +m[1] !== new Date().getUTCFullYear();
  const dag = d.toLocaleDateString("sv-SE", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(år ? { year: "numeric" } : {}) });
  return `${dag} ${m[4]}`;
}

const STOCKHOLM = "Europe/Stockholm";
const dagnyckel = (d: string | Date) => new Date(d).toLocaleDateString("sv-SE", { timeZone: STOCKHOLM });
const klocka = (iso: string) => new Date(iso).toLocaleTimeString("sv-SE", { timeZone: STOCKHOLM, hour: "2-digit", minute: "2-digit" });

/** "Idag", "Igår" eller "Torsdag 8 oktober". */
function dagnamn(nyckel: string): string {
  if (nyckel === dagnyckel(new Date())) return "Idag";
  if (nyckel === dagnyckel(new Date(Date.now() - 86400_000))) return "Igår";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nyckel);
  if (!m) return nyckel;
  const år = +m[1] !== new Date().getUTCFullYear();
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("sv-SE", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long", ...(år ? { year: "numeric" } : {}),
  });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function tidpunkt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });
}

function storlek(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
  return `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function meddelande(url: URL): Raw {
  const m = url.searchParams.get("meddelande");
  return m ? html`<p class="meddelande">${m}</p>` : raw("");
}

export const felruta = (text: string | null) => (text ? html`<p class="fel">${text}</p>` : raw(""));

export function sida(s: Inställningar | null, titel: string, innehåll: Raw, aktiv = ""): Raw {
  const länk = (väg: string, namn: string) =>
    html`<a href="${väg}"${raw(aktiv === väg ? ' aria-current="page"' : "")}>${namn}</a>`;
  return html`<html lang="sv">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex" />
      <meta name="theme-color" content="#FBF5EC" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#1A1411" media="(prefers-color-scheme: dark)" />
      <link rel="icon" type="image/svg+xml" href="${FAVICON}" />
      <title>${titel} · ${s?.name ?? "Snicksnack"}</title>
      <style>${raw(STIL)}</style>
    </head>
    <body>
      <header class="topp">
        <div class="inre">
          <div class="topprad">
            <a class="marke" href="/admin">${logga()}<span>${s?.name ?? "Snicksnack"}</span></a>
            ${s
              ? html`<form method="post" action="/admin/logout"><button class="diskret liten">Logga ut</button></form>`
              : ""}
          </div>
          ${s
            ? html`<nav class="flikar" aria-label="Admin">
                ${länk("/admin/snack", "Snack")}${länk("/admin/mal", "Mål")}${länk("/admin/avsandare", "Avsändare")}${länk(
                  "/admin/prompter",
                  "Prompter",
                )}${länk("/admin/leverantorer", "Leverantörer")}${länk("/admin/installningar", "Inställningar")}
              </nav>`
            : ""}
        </div>
      </header>
      <main>${innehåll}</main>
      <script>${raw(SKRIPT)}</script>
    </body>
  </html>`;
}

export async function formulär(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export const fält = (f: FormData, namn: string) => {
  const v = f.get(namn);
  return typeof v === "string" ? v.trim() : "";
};

export const flera = (f: FormData, namn: string) => f.getAll(namn).filter((v): v is string => typeof v === "string");

// ---------- Inloggning ----------

function säkerNästa(url: URL): string {
  const n = url.searchParams.get("next") ?? "";
  return n.startsWith("/admin") && !n.startsWith("//") ? n : "/admin/snack";
}

function loginSida(url: URL, fel: string | null = null, status = 200): Response {
  return htmlSvar(
    sida(
      null,
      "Logga in",
      html`<div class="lugn">
        ${rubrik("Logga in", "Adminsidan för mottagaren.")}
        ${felruta(fel)}
        <form method="post" action="/admin/login?next=${encodeURIComponent(säkerNästa(url))}" class="kort">
          ${fältrad("Lösenord", html`<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required />`)}
          <button class="bred">Logga in</button>
        </form>
      </div>`,
    ),
    status,
  );
}

async function loggaIn(req: Request, env: Env, url: URL): Promise<Response> {
  const f = await formulär(req);
  if (!(await rättLösenord(env.ADMIN_PASSWORD, fält(f, "password")))) return loginSida(url, "Fel lösenord.", 401);
  const värde = await skapaSession(env.ADMIN_PASSWORD);
  return omdirigera(säkerNästa(url), { "Set-Cookie": cookie(url, värde, SESSION_DAGAR * 86400) });
}

// ---------- Snack ----------

async function snackLista(env: Env, s: Inställningar, url: URL): Promise<Response> {
  const målFilter = url.searchParams.get("mal") ?? "";
  const avsFilter = url.searchParams.get("avsandare") ?? "";
  const [rader, mål, avsändare] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*, t.name AS target_name, se.name AS sender_name FROM snacks s
       LEFT JOIN targets t ON t.id = s.target_id LEFT JOIN senders se ON se.id = s.sender_id
       WHERE (?1 = '' OR s.target_id = ?1) AND (?2 = '' OR s.sender_id = ?2)
       ORDER BY s.updated_at DESC LIMIT 500`,
    )
      .bind(målFilter, avsFilter)
      .all<SnackRad>(),
    allaMål(env.DB),
    allaAvsändare(env.DB),
  ]);
  const val = (alla: { id: string; name: string }[], valt: string) =>
    alla.map((x) => html`<option value="${x.id}"${raw(x.id === valt ? " selected" : "")}>${x.name}</option>`);

  // Grupperat per dag som i appens arkiv (efter när snacket kom in, senaste först)
  const dagar = new Map<string, SnackRad[]>();
  for (const r of rader.results) {
    const dag = dagnyckel(r.updated_at);
    dagar.set(dag, [...(dagar.get(dag) ?? []), r]);
  }
  const rad = (r: SnackRad) => html`<a class="radlank" href="/admin/snack${vägTill(r.target_id, r.sender_id, r.snack_id)}">
    <div class="radtext">
      <div class="radtopp"><span class="namn">${r.title || r.snack_id}</span><time>${klocka(r.updated_at)}</time></div>
      <div class="meta">${inspeladLång(r.recorded_at)} · ${längd(r.duration)}</div>
      <div class="meta">${r.target_name ?? r.target_id} · ${r.sender_name ?? r.sender_id}${r.sends > 1 ? ` · skickat ${r.sends} gånger` : ""}</div>
    </div>
    <span class="chev">›</span>
  </a>`;

  const filtrerat = Boolean(målFilter || avsFilter);
  const innehåll = rader.results.length
    ? [...dagar].map(([dag, rr]) => html`<h2 class="dag">${dagnamn(dag)}</h2><div class="lista">${rr.map(rad)}</div>`)
    : tomt(filtrerat ? "Inga snack med det urvalet." : "Här är det tyst. När någon skickar ett snack hamnar det här.");

  return htmlSvar(
    sida(
      s,
      "Snack",
      html`${rubrik("Mottagna snack", "Allt som skickats hit från Snicksnack.")}
        ${meddelande(url)}
        ${rader.results.length || filtrerat
          ? html`<form method="get" class="filter">
              <select name="mal" aria-label="Mål"><option value="">Alla mål</option>${val(mål, målFilter)}</select>
              <select name="avsandare" aria-label="Avsändare"><option value="">Alla avsändare</option>${val(avsändare, avsFilter)}</select>
              <button class="diskret liten">Visa</button>
            </form>`
          : ""}
        ${innehåll}`,
      "/admin/snack",
    ),
  );
}

async function hämtaSnack(env: Env, t: string, a: string, id: string): Promise<SnackRad> {
  const r = await env.DB.prepare(
    `SELECT s.*, t.name AS target_name, se.name AS sender_name FROM snacks s
     LEFT JOIN targets t ON t.id = s.target_id LEFT JOIN senders se ON se.id = s.sender_id
     WHERE s.target_id = ? AND s.sender_id = ? AND s.snack_id = ?`,
  )
    .bind(t, a, id)
    .first<SnackRad>();
  if (!r) throw new EjFunnen();
  return r;
}

interface Punkt {
  section?: string;
  text?: string;
  at?: number | null;
}

interface Sammanfattning {
  kind?: string;
  name?: string;
  created_at?: string;
  items?: Punkt[];
}

interface Ord {
  text?: string;
  start?: number;
  end?: number;
  speaker?: number | null;
}

interface Transkript {
  text?: string;
  note?: string | null;
  words?: Ord[];
  speakers?: Record<string, string>;
  speakers_hidden?: boolean;
  summaries?: Sammanfattning[];
}

const SORTNAMN: Record<string, string> = {
  short: "Kort",
  decisions: "Beslut och att göra",
  minutes: "Protokoll",
  quotes: "Citat",
};

const FILTITEL: Record<string, string> = {
  "audio.m4a": "Ljud",
  "audio.wav": "Ljud",
  "transcript.json": "Transkript som data",
  "text.md": "Text i markdown",
};

/** "0:12", "12:04" eller "1:02:09". */
function tidkod(sek: number): string {
  const s = Math.max(0, Math.floor(sek));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** En tidkod; med ljud blir den en knapp som spelar därifrån. */
function tidmärke(sek: number, spelbar: boolean): Raw {
  return spelbar
    ? html`<button type="button" class="tid" data-t="${sek}" title="Spela härifrån">${tidkod(sek)}</button>`
    : html`<span class="tid">${tidkod(sek)}</span>`;
}

const talarklass = (t: number | null) => (t === null ? "" : `t${Math.abs(Math.trunc(t)) % 6}`);

/** Transkriptet i serif med talarbyten, eller null om det inte finns någon text. */
function transkriptHtml(t: Transkript, spelbar: boolean): Raw | null {
  const ord = Array.isArray(t.words) ? t.words.filter((o) => o && typeof o.text === "string") : [];
  if (!ord.length) {
    if (typeof t.text !== "string" || !t.text.trim()) return null;
    return html`<div class="transkript">${t.text.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div>`;
  }
  const namn = t.speakers && typeof t.speakers === "object" ? t.speakers : {};
  const visaTalare = !t.speakers_hidden && ord.some((o) => typeof o.speaker === "number");
  const repliker: { talare: number | null; start: number; stycken: string[][] }[] = [];
  let förra: Ord | null = null;
  for (const o of ord) {
    const talare = visaTalare && typeof o.speaker === "number" ? o.speaker : null;
    const sista = repliker.at(-1);
    const paus = förra && typeof o.start === "number" && typeof förra.end === "number" ? o.start - förra.end : 0;
    const stycke = sista?.stycken.at(-1);
    if (!sista || !stycke || (visaTalare && talare !== sista.talare)) {
      repliker.push({ talare, start: o.start ?? 0, stycken: [[o.text!]] });
    } else if (paus >= 3 || (stycke.length > 90 && /[.!?]$/.test(förra?.text ?? ""))) {
      sista.stycken.push([o.text!]);
    } else {
      stycke.push(o.text!);
    }
    förra = o;
  }
  return html`<div class="transkript">
    ${repliker.map(
      (r) => html`<div class="replik">
        ${visaTalare
          ? html`<div class="talare ${talarklass(r.talare)}">${r.talare === null ? "Okänd talare" : (namn[String(r.talare)] ?? `Talare ${r.talare + 1}`)}
              ${tidmärke(r.start, spelbar)}</div>`
          : ""}
        ${r.stycken.map((s) => html`<p>${s.join(" ")}</p>`)}
      </div>`,
    )}
  </div>`;
}

/** En sammanfattning: rundad och märkt Maskinskrivet, utom citaten som är det människor sa. */
function sammanfattningHtml(sm: Sammanfattning, spelbar: boolean): Raw {
  const avsnitt = new Map<string, Punkt[]>();
  for (const p of Array.isArray(sm.items) ? sm.items : []) {
    const k = p.section ?? "";
    avsnitt.set(k, [...(avsnitt.get(k) ?? []), p]);
  }
  return html`<section class="sammanfattning">
    <div class="maskin"><span>${sm.name || SORTNAMN[sm.kind ?? ""] || "Sammanfattning"}</span><span>Maskinskrivet</span></div>
    ${[...avsnitt].map(([rubrik, punkter]) => {
      const citat = rubrik === "Citat" || sm.kind === "quotes";
      return html`${rubrik ? html`<h3>${rubrik}</h3>` : ""}
        <ul class="punkter${citat ? " citat" : ""}">
          ${punkter.map((p) => html`<li>${p.text ?? ""}${typeof p.at === "number" ? tidmärke(p.at, spelbar) : ""}</li>`)}
        </ul>`;
    })}
  </section>`;
}

async function snackSida(env: Env, s: Inställningar, t: string, a: string, id: string, url: URL): Promise<Response> {
  const r = await hämtaSnack(env, t, a, id);
  const prefix = `${t}/${a}/${id}/`;
  const [lista, textObj, transObj] = await Promise.all([
    env.FILER.list({ prefix }),
    env.FILER.get(prefix + "text.md"),
    env.FILER.get(prefix + "transcript.json"),
  ]);
  const text = textObj ? await textObj.text() : null;
  let transkript: Transkript = {};
  if (transObj) {
    try {
      transkript = await transObj.json();
    } catch {
      // trasig JSON: visa bara filerna
    }
  }
  const taggar: string[] = JSON.parse(r.tags || "[]");
  const filväg = (namn: string) => "/admin/fil" + vägTill(t, a, id, namn);
  const ljud = lista.objects.find((o) => o.key.endsWith("/audio.m4a") || o.key.endsWith("/audio.wav"));
  const titel = r.title || r.snack_id;

  const talare = new Set(
    transkript.speakers_hidden || !Array.isArray(transkript.words) ? [] : transkript.words.map((o) => o?.speaker).filter((x) => typeof x === "number"),
  ).size;
  const metarad = [inspeladLång(r.recorded_at), längd(r.duration), talare > 1 ? `${talare} talare` : ""].filter(Boolean).join(" · ");

  // transcript.json är huvudsaken; text.md visas bara som text när det inte finns något transkript
  const brödtext = transkriptHtml(transkript, !!ljud);
  const huvud = brödtext ?? (text ? html`<pre class="text">${text}</pre>` : tomt("Ingen text kom med det här snacket."));
  const sammanfattningar = Array.isArray(transkript.summaries) ? transkript.summaries.filter((x) => Array.isArray(x?.items) && x.items.length) : [];
  const innehåll = sammanfattningar.length
    ? html`<div class="flikvy">
        <input type="radio" name="vy" id="vy-t" checked /><input type="radio" name="vy" id="vy-s" />
        <div class="segment"><label for="vy-t">Transkript</label><label for="vy-s">Sammanfattning</label></div>
        <div class="panel-t">${huvud}</div>
        <div class="panel-s">${sammanfattningar.map((sm) => sammanfattningHtml(sm, !!ljud))}</div>
      </div>`
    : huvud;

  return htmlSvar(
    sida(
      s,
      titel,
      html`<div class="sidhuvud">
          <a class="tillbaka" href="/admin/snack">‹ Snack</a>
          <h1>${titel}</h1>
          <p class="ingress">${metarad}</p>
          <div class="chips">
            <a class="chip" href="/admin/snack?mal=${encodeURIComponent(t)}">${r.target_name ?? t}</a>
            <a class="chip" href="/admin/snack?avsandare=${encodeURIComponent(a)}">${r.sender_name ?? a}</a>
            ${taggar.map((x) => html`<span class="chip tagg">#${x}</span>`)}
          </div>
        </div>
        ${meddelande(url)}
        ${ljud ? html`<div class="kort spelare"><audio controls preload="metadata" src="${filväg(ljud.key.slice(prefix.length))}"></audio></div>` : ""}
        ${typeof transkript.note === "string" && transkript.note.trim()
          ? html`<div class="kort"><div class="maskin"><span>Anteckning</span></div><p class="anteckning">${transkript.note}</p></div>`
          : ""}
        ${innehåll}
        ${lista.objects.length
          ? html`<h2>Ladda ner</h2>
              <div class="lista">
                ${lista.objects.map((o) => {
                  const namn = o.key.slice(prefix.length);
                  return html`<a class="radlank" href="${filväg(namn)}?ladda=1" download>
                    <div class="radtext"><div class="namn">${FILTITEL[namn] ?? namn}</div><div class="meta fil">${namn} · ${storlek(o.size)}</div></div>
                    <span class="chev">↓</span>
                  </a>`;
                })}
              </div>`
          : ""}
        ${text && brödtext ? html`<details class="kort inlagt"><summary>Visa text.md</summary><pre class="text">${text}</pre></details>` : ""}
        <h2>Om snacket</h2>
        <div class="kort">
          <dl class="fakta">
            <div><dt>Mottaget</dt><dd>${tidpunkt(r.received_at)}</dd></div>
            ${r.sends > 1 ? html`<div><dt>Senast</dt><dd>${tidpunkt(r.updated_at)}, ${r.sends} sändningar</dd></div>` : ""}
            ${r.language ? html`<div><dt>Språk</dt><dd>${r.language}</dd></div>` : ""}
            <div><dt>Id</dt><dd><code>${t}/${a}/${id}</code></dd></div>
          </dl>
        </div>
        <form method="post" action="/admin/snack${vägTill(t, a, id)}/ta-bort" class="knappar"
          onsubmit="return confirm('Ta bort snacket och dess filer?')">
          <button class="farlig">Ta bort snacket</button>
        </form>`,
      "/admin/snack",
    ),
  );
}

async function taBortSnack(env: Env, t: string, a: string, id: string): Promise<Response> {
  await hämtaSnack(env, t, a, id);
  const prefix = `${t}/${a}/${id}/`;
  const lista = await env.FILER.list({ prefix });
  if (lista.objects.length) await env.FILER.delete(lista.objects.map((o) => o.key));
  await env.DB.prepare("DELETE FROM snacks WHERE target_id = ? AND sender_id = ? AND snack_id = ?").bind(t, a, id).run();
  return medMeddelande("/admin/snack", "Snacket är borttaget.");
}

async function fil(req: Request, env: Env, t: string, a: string, id: string, namn: string, url: URL): Promise<Response> {
  if (!FILNAMN.includes(namn)) throw new EjFunnen();
  const nyckel = `${t}/${a}/${id}/${namn}`;
  // Range behövs för att ljudspelaren i Safari ska kunna spela upp.
  const obj = await env.FILER.get(nyckel, { range: req.headers, onlyIf: req.headers });
  if (!obj) throw new EjFunnen();
  const huvuden = new Headers({ "Cache-Control": "private, no-cache", ETag: obj.httpEtag, "Accept-Ranges": "bytes" });
  obj.writeHttpMetadata(huvuden);
  if (url.searchParams.has("ladda")) {
    huvuden.set("Content-Disposition", `attachment; filename="${id}-${namn}"`);
  }
  if (!("body" in obj)) return new Response(null, { status: 304, headers: huvuden });
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (req.headers.has("Range") && r && r.offset !== undefined) {
    const längd = r.length ?? obj.size - r.offset;
    huvuden.set("Content-Range", `bytes ${r.offset}-${r.offset + längd - 1}/${obj.size}`);
    huvuden.set("Content-Length", String(längd));
    return new Response(obj.body, { status: 206, headers: huvuden });
  }
  return new Response(obj.body, { headers: huvuden });
}

// ---------- Mål ----------

async function målSida(env: Env, s: Inställningar, url: URL, fel: string | null = null, status = 200): Promise<Response> {
  const [mål, antal] = await Promise.all([
    allaMål(env.DB),
    env.DB.prepare(
      `SELECT t.id, (SELECT COUNT(*) FROM sender_targets st WHERE st.target_id = t.id) AS avs,
              (SELECT COUNT(*) FROM snacks sn WHERE sn.target_id = t.id) AS snack FROM targets t`,
    ).all<{ id: string; avs: number; snack: number }>(),
  ]);
  const räkning = new Map(antal.results.map((r) => [r.id, r]));
  return htmlSvar(
    sida(
      s,
      "Mål",
      html`${rubrik("Mål", "Det avsändarna väljer när de skickar: kund, projekt eller mapp.")}
        ${meddelande(url)} ${felruta(fel)}
        ${mål.length
          ? html`<div class="lista">
              ${mål.map((m, i) => {
                const r = räkning.get(m.id);
                return html`<details class="post">
                  <summary>
                    <div class="radtext">
                      <div class="namn">${m.name}</div>
                      <div class="meta">${m.grp ? `${m.grp} · ` : ""}${r?.avs ?? 0} avsändare · ${r?.snack ?? 0} snack</div>
                    </div>
                    <span class="chev">›</span>
                  </summary>
                  <div class="postinnehall">
                    <form id="ta-bort-mal-${i}" method="post" action="/admin/mal/${encodeURIComponent(m.id)}/ta-bort"
                      onsubmit="return confirm('Ta bort målet? Mottagna snack ligger kvar.')"></form>
                    <form method="post" action="/admin/mal/${encodeURIComponent(m.id)}">
                      ${fältrad("Namn", html`<input type="text" name="name" value="${m.name}" required />`)}
                      ${fältrad("Grupp", html`<input type="text" name="group" value="${m.grp ?? ""}" placeholder="Ingen grupp" />`)}
                      <p class="tips">Id <code>${m.id}</code> · <a href="/admin/snack?mal=${encodeURIComponent(m.id)}">Visa snacken</a></p>
                      <div class="knappar">
                        <button>Spara</button>
                        <span class="hoger"><button class="farlig" form="ta-bort-mal-${i}">Ta bort</button></span>
                      </div>
                    </form>
                  </div>
                </details>`;
              })}
            </div>`
          : tomt("Inga mål än. Skapa ett så har avsändarna något att välja.")}
        <details class="lista post ny"${raw(!mål.length || fel ? " open" : "")}>
          <summary><span class="plus">+</span><span class="radtext">Nytt mål</span></summary>
          <div class="postinnehall">
            <form method="post" action="/admin/mal">
              ${fältrad("Namn", html`<input type="text" name="name" required placeholder="Inkorg" />`)}
              ${fältrad(
                "Id",
                html`<input type="text" name="id" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" placeholder="Av namnet, t.ex. inbox" />`,
                "Valfritt. Gemener, siffror och - _ . Går inte att ändra sedan, filerna sparas under det.",
              )}
              ${fältrad("Grupp", html`<input type="text" name="group" placeholder="Kunder" />`, "Valfri. Grupperar målen i appen.")}
              <div class="knappar"><button>Skapa mål</button></div>
            </form>
          </div>
        </details>`,
      "/admin/mal",
    ),
    status,
  );
}

async function skapaMål(req: Request, env: Env, s: Inställningar): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  const id = fält(f, "id") || slug(namn);
  const url = new URL(req.url);
  if (!namn) return målSida(env, s, url, "Målet behöver ett namn.", 400);
  if (!MÅL_ID.test(id)) return målSida(env, s, url, `Id:t "${id}" går inte: gemener, siffror, - _ . (högst 64 tecken).`, 400);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO targets (id, name, grp, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, namn, fält(f, "group") || null, nu())
    .run();
  if (!r.meta.changes) return målSida(env, s, url, `Det finns redan ett mål med id "${id}".`, 409);
  return medMeddelande("/admin/mal", `Målet ${namn} är skapat. Tilldela det till avsändare under Avsändare.`);
}

async function ändraMål(req: Request, env: Env, id: string): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  if (!namn) return medMeddelande("/admin/mal", "Målet behöver ett namn.");
  const r = await env.DB.prepare("UPDATE targets SET name = ?, grp = ? WHERE id = ?")
    .bind(namn, fält(f, "group") || null, id)
    .run();
  if (!r.meta.changes) throw new EjFunnen();
  return medMeddelande("/admin/mal", "Sparat.");
}

async function taBortMål(env: Env, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sender_targets WHERE target_id = ?").bind(id),
    env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(id),
  ]);
  return medMeddelande("/admin/mal", "Målet är borttaget. Snacken som redan kommit in ligger kvar.");
}

// ---------- Avsändare ----------

function målVal(mål: Mål[], valda: string[]): Raw {
  if (!mål.length) return html`<span class="tips">Inga mål än. <a href="/admin/mal">Skapa ett mål</a> först.</span>`;
  return html`${mål.map(
    (m) =>
      html`<label class="val"><input type="checkbox" name="targets" value="${m.id}"${raw(valda.includes(m.id) ? " checked" : "")} />
        ${m.name}${m.grp ? html` <span class="dim">${m.grp}</span>` : ""}</label>`,
  )}`;
}

async function avsändarSida(env: Env, s: Inställningar, url: URL, fel: string | null = null, status = 200): Promise<Response> {
  const [avsändare, mål, prompter, tilldelade] = await Promise.all([
    allaAvsändare(env.DB),
    allaMål(env.DB),
    allaPrompter(env.DB),
    env.DB.prepare("SELECT sender_id, prompt_id FROM sender_prompts").all<{ sender_id: string; prompt_id: string }>(),
  ]);
  const prompterFör = (id: string) => tilldelade.results.filter((r) => r.sender_id === id).map((r) => r.prompt_id);
  return htmlSvar(
    sida(
      s,
      "Avsändare",
      html`${rubrik("Avsändare", "Varje person får en egen nyckel och ser bara de mål du väljer.")}
        ${meddelande(url)} ${felruta(fel)}
        ${avsändare.length
          ? html`<div class="lista">
              ${avsändare.map(
                (a, i) => html`<details class="post">
                  <summary>
                    <div class="radtext">
                      <div class="namn">${a.name}</div>
                      <div class="meta">${a.key_hint ? `Nyckel …${a.key_hint}` : "Spärrad"} · ${a.targets.length} mål · ${prompterFör(a.id).length} prompter</div>
                    </div>
                    <span class="chev">›</span>
                  </summary>
                  <div class="postinnehall">
                    <form id="nyckel-${i}" method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/ny-nyckel"
                      onsubmit="return confirm('Skapa en ny nyckel? Den gamla slutar fungera.')"></form>
                    ${a.key_hint
                      ? html`<form id="stang-${i}" method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/sparra"
                          onsubmit="return confirm('Spärra avsändaren? Nyckeln slutar fungera direkt.')"></form>`
                      : html`<form id="stang-${i}" method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/ta-bort"
                          onsubmit="return confirm('Ta bort avsändaren? Mottagna snack ligger kvar.')"></form>`}
                    <form method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}">
                      ${fältrad("Namn", html`<input type="text" name="name" value="${a.name}" required />`)}
                      ${valgrupp("Mål", målVal(mål, a.targets))}
                      ${valgrupp("Prompter", promptVal(prompter, prompterFör(a.id)))}
                      <p class="tips">Id <code>${a.id}</code> · skapad ${tidpunkt(a.created_at)} ·
                        <a href="/admin/snack?avsandare=${encodeURIComponent(a.id)}">Visa snacken</a></p>
                      <div class="knappar">
                        <button>Spara</button>
                        <span class="hoger">
                          <button class="diskret" form="nyckel-${i}">${a.key_hint ? "Ny nyckel" : "Ge en ny nyckel"}</button>
                          <button class="farlig" form="stang-${i}">${a.key_hint ? "Spärra" : "Ta bort"}</button>
                        </span>
                      </div>
                    </form>
                  </div>
                </details>`,
              )}
            </div>`
          : tomt("Ingen skickar hit än. Lägg till den första nedan.")}
        <details class="lista post ny"${raw(!avsändare.length || fel ? " open" : "")}>
          <summary><span class="plus">+</span><span class="radtext">Ny avsändare</span></summary>
          <div class="postinnehall">
            <form method="post" action="/admin/avsandare">
              ${fältrad("Namn", html`<input type="text" name="name" required placeholder="Anna Andersson" />`)}
              ${valgrupp("Mål", målVal(mål, mål.length === 1 ? [mål[0].id] : []))}
              ${valgrupp("Prompter", promptVal(prompter, []), "Extern AI: sammanfattningar och chatt.")}
              <div class="knappar"><button>Skapa och visa nyckel</button></div>
            </form>
          </div>
        </details>`,
      "/admin/avsandare",
    ),
    status,
  );
}

async function ledigtId(db: D1Database, namn: string): Promise<string> {
  const bas = slug(namn);
  for (let i = 1; ; i++) {
    const id = i === 1 ? bas : `${bas}-${i}`;
    if (!(await db.prepare("SELECT 1 FROM senders WHERE id = ?").bind(id).first())) return id;
  }
}

async function sättMål(env: Env, avsändare: string, mål: string[]): Promise<void> {
  const giltiga = new Set((await allaMål(env.DB)).map((m) => m.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sender_targets WHERE sender_id = ?").bind(avsändare),
    ...[...new Set(mål)]
      .filter((m) => giltiga.has(m))
      .map((m) => env.DB.prepare("INSERT INTO sender_targets (sender_id, target_id) VALUES (?, ?)").bind(avsändare, m)),
  ]);
}

async function skapaAvsändare(req: Request, env: Env, s: Inställningar, url: URL): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  if (!namn) return avsändarSida(env, s, url, "Avsändaren behöver ett namn.", 400);
  const id = await ledigtId(env.DB, namn);
  const nyckel = nyNyckel();
  await env.DB.prepare("INSERT INTO senders (id, name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, namn, await sha256Hex(nyckel), nyckel.slice(-4), nu())
    .run();
  await sättMål(env, id, flera(f, "targets"));
  await sättPrompterFörAvsändare(env.DB, id, flera(f, "prompts"));
  return nyckelSida(s, namn, nyckel, url);
}

async function ändraAvsändare(req: Request, env: Env, id: string): Promise<Response> {
  const f = await formulär(req);
  const namn = fält(f, "name");
  if (!namn) return medMeddelande("/admin/avsandare", "Avsändaren behöver ett namn.");
  const r = await env.DB.prepare("UPDATE senders SET name = ? WHERE id = ?").bind(namn, id).run();
  if (!r.meta.changes) throw new EjFunnen();
  await sättMål(env, id, flera(f, "targets"));
  await sättPrompterFörAvsändare(env.DB, id, flera(f, "prompts"));
  return medMeddelande("/admin/avsandare", `${namn} är sparad.`);
}

async function spärra(env: Env, id: string): Promise<Response> {
  const r = await env.DB.prepare("UPDATE senders SET key_hash = NULL, key_hint = NULL, revoked_at = ? WHERE id = ?")
    .bind(nu(), id)
    .run();
  if (!r.meta.changes) throw new EjFunnen();
  return medMeddelande("/admin/avsandare", "Avsändaren är spärrad. Nyckeln fungerar inte längre.");
}

async function bytNyckel(env: Env, s: Inställningar, id: string, url: URL): Promise<Response> {
  const nyckel = nyNyckel();
  const rad = await env.DB.prepare(
    "UPDATE senders SET key_hash = ?, key_hint = ?, revoked_at = NULL WHERE id = ? RETURNING name",
  )
    .bind(await sha256Hex(nyckel), nyckel.slice(-4), id)
    .first<{ name: string }>();
  if (!rad) throw new EjFunnen();
  return nyckelSida(s, rad.name, nyckel, url);
}

async function taBortAvsändare(env: Env, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sender_targets WHERE sender_id = ?").bind(id),
    env.DB.prepare("DELETE FROM senders WHERE id = ? AND key_hash IS NULL").bind(id),
  ]);
  return medMeddelande("/admin/avsandare", "Avsändaren är borttagen. Snacken ligger kvar.");
}

/** Kopplingslänken som appen läser ur QR-koden (docs/protokoll.md). */
export function kopplingslänk(origin: string, nyckel: string): string {
  return `snicksnack://receiver?url=${origin}&key=${nyckel}`;
}

function nyckelSida(s: Inställningar, namn: string, nyckel: string, url: URL): Response {
  const länk = kopplingslänk(url.origin, nyckel);
  const qr = qrcode(0, "M");
  qr.addData(länk);
  qr.make();
  return htmlSvar(
    sida(
      s,
      `Nyckel för ${namn}`,
      html`<div class="lugn">
        ${rubrik("Skanna i Snicksnack", `Nyckeln för ${namn}. Lägg till en mottagare i appen och rikta kameran hit.`)}
        <div class="qr">${raw(qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }))}</div>
        <p class="meddelande">Koden visas bara nu. Tappas den bort gör du en ny nyckel under Avsändare.</p>
        <details class="kort inlagt">
          <summary>Skicka länken i stället</summary>
          <dl class="fakta" style="margin-top:8px">
            <div><dt>Adress</dt><dd><code>${url.origin}</code></dd></div>
            <div><dt>Nyckel</dt><dd><code>${nyckel}</code></dd></div>
            <div><dt>Länk</dt><dd><code>${länk}</code></dd></div>
          </dl>
          <div class="knappar"><button type="button" class="diskret" data-kopiera="${länk}">Kopiera länken</button></div>
        </details>
        <div class="knappar"><a class="knapp" href="/admin/avsandare">Klar</a></div>
      </div>`,
      "/admin/avsandare",
    ),
  );
}

// ---------- Inställningar ----------

async function inställningsSida(env: Env, s: Inställningar, url: URL, fel: string | null = null, status = 200): Promise<Response> {
  const { results: leverantörer } = await env.DB.prepare("SELECT id, name FROM providers ORDER BY name").all<{ id: string; name: string }>();
  return htmlSvar(
    sida(
      s,
      "Inställningar",
      html`${rubrik("Inställningar", "Så ser mottagaren ut i Snicksnack, och vad den tar emot.")}
        ${meddelande(url)} ${felruta(fel)}
        <form method="post" action="/admin/installningar" enctype="multipart/form-data">
          <h2>I appen</h2>
          <div class="kort">
            <div class="forhand">
              ${s.icon ? html`<img src="/icon.png?v=${ikonversion(s.icon)}" alt="" />` : logga()}
              <div class="radtext"><div class="namn">${s.name}</div><div class="meta">Adress för appen: <code>${url.origin}</code></div></div>
            </div>
            ${fältrad("Namn", html`<input id="namn" type="text" name="name" value="${s.name}" required maxlength="60" />`)}
            <fieldset class="falt">
              <legend class="etikett">Färg</legend>
              <div class="sidvid">
                <input id="farg" type="color" name="color" value="${s.color ?? STANDARDFÄRG}" aria-label="Färg" />
                ${växel("no_color", "Ingen egen färg", !s.color)}
              </div>
            </fieldset>
            <fieldset class="falt">
              <legend class="etikett">Logga</legend>
              ${s.icon ? växel("remove_icon", "Ta bort loggan", false) : ""}
              <input type="file" name="icon" accept="image/png" aria-label="Logga" />
              <span class="tips">Kvadratisk PNG, minst 256 px och högst 2 MB.</span>
            </fieldset>
          </div>
          <h2>Det här tas emot</h2>
          <div class="kort">
            ${valgrupp(
              "Vad appen ska skicka",
              DELAR.map(
                (d) => html`<label class="val"><input type="checkbox" name="accepts" value="${d}"${raw(s.accepts.includes(d) ? " checked" : "")} /> ${DELNAMN[d]}</label>`,
              ),
              "Ljud i Apple Lossless tar ungefär 66 MB per timme. Utan ljud blir sändningarna små.",
            )}
          </div>
          <h2>Fri fråga i chatten</h2>
          <div class="kort">
            <p class="tips" style="margin:0 2px 16px">När någon skriver en egen fråga i stället för att välja en prompt. Kräver minst en chattprompt.</p>
            ${fältrad(
              "Leverantör",
              html`<select id="chat_provider" name="chat_provider">
                <option value="">Som första chattprompten</option>
                ${leverantörer.map((l) => html`<option value="${l.id}"${raw(l.id === s.chatProvider ? " selected" : "")}>${l.name}</option>`)}
              </select>`,
            )}
            ${fältrad("Modell", html`<input id="chat_model" type="text" name="chat_model" value="${s.chatModel ?? ""}" placeholder="Leverantörens standard" />`)}
            ${fältrad(
              "Systemtext",
              html`<textarea id="chat_system" name="chat_system" rows="4" placeholder="Den inbyggda">${s.chatSystem}</textarea>`,
              "Gäller också prompter utan egen systemtext.",
            )}
          </div>
          <div class="knappar"><button>Spara</button></div>
        </form>`,
      "/admin/installningar",
    ),
    status,
  );
}

/** Bredd och höjd ur en PNG:s IHDR, eller null om det inte är en PNG. */
export function pngStorlek(b: Uint8Array): { bredd: number; höjd: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((x, i) => b[i] !== x)) return null;
  if (String.fromCharCode(...b.slice(12, 16)) !== "IHDR") return null;
  const v = new DataView(b.buffer, b.byteOffset);
  return { bredd: v.getUint32(16), höjd: v.getUint32(20) };
}

async function sparaInställningar(req: Request, env: Env, s: Inställningar): Promise<Response> {
  const url = new URL(req.url);
  const f = await formulär(req);
  const namn = fält(f, "name").slice(0, 60);
  if (!namn) return await inställningsSida(env, s, url, "Mottagaren behöver ett namn.", 400);
  const färg = fält(f, "color").toUpperCase();
  if (!f.has("no_color") && !/^#[0-9A-F]{6}$/.test(färg)) return await inställningsSida(env, s, url, "Färgen ska vara #RRGGBB.", 400);
  const accepts = DELAR.filter((d) => flera(f, "accepts").includes(d));
  if (!accepts.length) return await inställningsSida(env, s, url, "Välj minst en del att ta emot.", 400);

  const ikon = f.get("icon") as unknown;
  let ikonbytes: Uint8Array | null = null;
  if (ikon && typeof ikon === "object" && (ikon as File).size > 0) {
    const fil = ikon as File;
    if (fil.size > STÖRSTA_IKON) return await inställningsSida(env, s, url, "Loggan är större än 2 MB.", 400);
    ikonbytes = new Uint8Array(await fil.arrayBuffer());
    const mått = pngStorlek(ikonbytes);
    if (!mått) return await inställningsSida(env, s, url, "Loggan ska vara en PNG.", 400);
    if (mått.bredd !== mått.höjd || mått.bredd < 256) {
      return await inställningsSida(env, s, url, `Loggan ska vara kvadratisk och minst 256 px (den är ${mått.bredd}×${mått.höjd}).`, 400);
    }
  }

  await sättInställning(env.DB, "name", namn);
  await sättInställning(env.DB, "color", f.has("no_color") ? null : färg);
  await sättInställning(env.DB, "accepts", JSON.stringify(accepts));
  await sättInställning(env.DB, "chat_provider", fält(f, "chat_provider") || null);
  await sättInställning(env.DB, "chat_model", fält(f, "chat_model") || null);
  await sättInställning(env.DB, "chat_system", fält(f, "chat_system") || null);
  if (ikonbytes) {
    await env.FILER.put(IKON_NYCKEL, ikonbytes, { httpMetadata: { contentType: "image/png" } });
    await sättInställning(env.DB, "icon", nu());
  } else if (f.has("remove_icon")) {
    await env.FILER.delete(IKON_NYCKEL);
    await sättInställning(env.DB, "icon", null);
  }
  return medMeddelande("/admin/installningar", "Sparat.");
}

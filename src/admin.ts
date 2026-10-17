// Admin på /admin: inställningar, mål, avsändare och mottagna snack. Enkel HTML direkt från Workern.

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
        html`<p>Sätt ett lösenord för admin först:</p>
          <pre>npx wrangler secret put ADMIN_PASSWORD</pre>
          <p>Lokalt med <code>wrangler dev</code>: lägg <code>ADMIN_PASSWORD=…</code> i <code>.dev.vars</code>.</p>`,
      ),
      503,
    );
  }

  // Formulär får bara postas från den egna sidan (skydd mot CSRF utöver SameSite på cookien).
  if (req.method === "POST") {
    const ursprung = req.headers.get("Origin");
    if (ursprung && ursprung !== url.origin) return htmlSvar(sida(null, "Nekad", html`<p>Fel ursprung.</p>`), 403);
  }

  if (väg === "/admin/login") return req.method === "POST" ? loggaIn(req, env, url) : loginSida(url);
  if (väg === "/admin/logout" && req.method === "POST") {
    return omdirigera("/admin/login", { "Set-Cookie": cookie(url, "", 0) });
  }

  if (!(await giltigSession(lösen, läsCookie(req, COOKIE)))) {
    if (req.method === "GET") return omdirigera(`/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return htmlSvar(sida(null, "Inte inloggad", html`<p><a href="/admin/login">Logga in</a></p>`), 401);
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
  return htmlSvar(sida(s ?? (await hämtaInställningar(env.DB)), "Finns inte", html`<p>Sidan finns inte.</p>`), 404);
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
  const färg = s?.color ?? STANDARDFÄRG;
  const länk = (väg: string, namn: string) =>
    html`<a href="${väg}"${raw(aktiv === väg ? ' aria-current="page"' : "")}>${namn}</a>`;
  return html`<html lang="sv">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>${titel} · ${s?.name ?? "Snicksnack-mottagare"}</title>
      <style>
        :root { --accent: ${raw(/^#[0-9A-Fa-f]{6}$/.test(färg) ? färg : STANDARDFÄRG)}; --bg: #faf9f7; --fg: #1d1d1f;
          --dim: #6e6e73; --kant: #e3e1dc; --yta: #fff; color-scheme: light dark; }
        @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ececec; --dim: #9a9a9f; --kant: #333; --yta: #1f1f1f; } }
        * { box-sizing: border-box; }
        body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          background: var(--bg); color: var(--fg); }
        header { border-bottom: 3px solid var(--accent); background: var(--yta); }
        header .inre, main { max-width: 980px; margin: 0 auto; padding: 12px 16px; }
        header .inre { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
        header strong { margin-right: auto; display: flex; gap: 8px; align-items: center; }
        header img { width: 28px; height: 28px; border-radius: 6px; }
        nav { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
        nav a { color: var(--fg); text-decoration: none; }
        nav a[aria-current] { color: var(--accent); font-weight: 600; }
        a { color: var(--accent); }
        h1 { font-size: 1.5rem; margin: 20px 0 12px; }
        h2 { font-size: 1.15rem; margin: 28px 0 10px; }
        table { border-collapse: collapse; width: 100%; background: var(--yta); }
        th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--kant); vertical-align: top; }
        th { font-weight: 600; font-size: .85rem; color: var(--dim); }
        .tabell { overflow-x: auto; }
        .kort { background: var(--yta); border: 1px solid var(--kant); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
        label { display: block; margin: 10px 0 4px; font-weight: 500; }
        label.val { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; margin: 4px 14px 4px 0; }
        input[type=text], input[type=password], select { font: inherit; padding: 7px 9px; border: 1px solid var(--kant);
          border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; max-width: 420px; }
        textarea { font: inherit; padding: 7px 9px; border: 1px solid var(--kant); border-radius: 6px; background: var(--bg);
          color: var(--fg); width: 100%; }
        input[type=color] { width: 60px; height: 36px; border: 1px solid var(--kant); border-radius: 6px; background: none; }
        button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent);
          color: #fff; cursor: pointer; }
        button.diskret { background: transparent; color: var(--accent); }
        button.farlig { background: transparent; color: #c0392b; border-color: #c0392b; }
        .rad { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
        .rad form { margin: 0; }
        .dim { color: var(--dim); }
        .meddelande { background: color-mix(in srgb, var(--accent) 14%, var(--yta)); padding: 8px 12px; border-radius: 6px; }
        .fel { background: #fdecea; color: #8a1c12; padding: 8px 12px; border-radius: 6px; }
        @media (prefers-color-scheme: dark) { .fel { background: #3b1714; color: #ffb4a9; } }
        code, pre { font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
        code { background: color-mix(in srgb, var(--fg) 7%, transparent); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
        pre.text { white-space: pre-wrap; background: var(--yta); border: 1px solid var(--kant); padding: 14px; border-radius: 8px; }
        .qr { background: #fff; padding: 12px; border-radius: 10px; width: min(320px, 100%); }
        .qr svg { width: 100%; height: auto; display: block; }
        .tagg { display: inline-block; border: 1px solid var(--kant); border-radius: 99px; padding: 0 8px; margin: 0 4px 4px 0; font-size: .85rem; }
        dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
        dt { color: var(--dim); }
        dd { margin: 0; }
        audio { width: 100%; max-width: 520px; }
      </style>
    </head>
    <body>
      <header>
        <div class="inre">
          <strong>${s?.icon ? html`<img src="/icon.png?v=${ikonversion(s.icon)}" alt="" />` : ""}${s?.name ?? "Snicksnack-mottagare"}</strong>
          ${s
            ? html`<nav>
                ${länk("/admin/snack", "Snack")} ${länk("/admin/mal", "Mål")} ${länk("/admin/avsandare", "Avsändare")}
                ${länk("/admin/prompter", "Prompter")} ${länk("/admin/leverantorer", "Leverantörer")}
                ${länk("/admin/installningar", "Inställningar")}
                <form method="post" action="/admin/logout" style="margin:0">
                  <button class="diskret" style="padding:2px 8px">Logga ut</button>
                </form>
              </nav>`
            : ""}
        </div>
      </header>
      <main>${innehåll}</main>
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
      html`<h1>Logga in</h1>
        ${felruta(fel)}
        <form method="post" action="/admin/login?next=${encodeURIComponent(säkerNästa(url))}" class="kort" style="max-width:460px">
          <label for="pw">Lösenord</label>
          <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required />
          <div class="rad"><button>Logga in</button></div>
        </form>`,
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

  const tabell = rader.results.length
    ? html`<div class="tabell"><table>
        <thead><tr><th>Titel</th><th>Inspelat</th><th>Längd</th><th>Mål</th><th>Avsändare</th><th>Mottaget</th></tr></thead>
        <tbody>
          ${rader.results.map(
            (r) => html`<tr>
              <td><a href="/admin/snack${vägTill(r.target_id, r.sender_id, r.snack_id)}">${r.title || r.snack_id}</a></td>
              <td>${inspelad(r.recorded_at)}</td>
              <td>${längd(r.duration)}</td>
              <td><a href="?mal=${encodeURIComponent(r.target_id)}">${r.target_name ?? r.target_id}</a></td>
              <td><a href="?avsandare=${encodeURIComponent(r.sender_id)}">${r.sender_name ?? r.sender_id}</a></td>
              <td class="dim">${tidpunkt(r.updated_at)}${r.sends > 1 ? html` (${r.sends} ggr)` : ""}</td>
            </tr>`,
          )}
        </tbody></table></div>`
    : html`<p class="dim">Inga snack ${målFilter || avsFilter ? "med det urvalet" : "än"}.</p>`;

  return htmlSvar(
    sida(
      s,
      "Snack",
      html`<h1>Mottagna snack</h1>
        ${meddelande(url)}
        <form method="get" class="rad" style="margin-bottom:14px">
          <select name="mal" style="width:auto"><option value="">Alla mål</option>${val(mål, målFilter)}</select>
          <select name="avsandare" style="width:auto"><option value="">Alla avsändare</option>${val(avsändare, avsFilter)}</select>
          <button class="diskret">Visa</button>
        </form>
        ${tabell}`,
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

interface Sammanfattning {
  kind?: string;
  items?: { section?: string; text?: string; at?: number | null }[];
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
  let transkript: { text?: string; summaries?: Sammanfattning[] } = {};
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

  // Sammanfattningarna ur transcript.json visas bara när det inte finns någon text.md (den innehåller dem redan).
  const sammanfattningar =
    !text && Array.isArray(transkript.summaries) && transkript.summaries.length
      ? html`<h2>Sammanfattningar</h2>
          ${transkript.summaries.map((sm) => {
            const avsnitt = new Map<string, string[]>();
            for (const i of sm.items ?? []) {
              const k = i.section ?? sm.kind ?? "";
              avsnitt.set(k, [...(avsnitt.get(k) ?? []), i.text ?? ""]);
            }
            return [...avsnitt].map(([rubrik, punkter]) => html`<h3>${rubrik}</h3><ul>${punkter.map((p) => html`<li>${p}</li>`)}</ul>`);
          })}`
      : "";

  const brödtext = text ?? transkript.text ?? null;

  return htmlSvar(
    sida(
      s,
      r.title || r.snack_id,
      html`<h1>${r.title || r.snack_id}</h1>
        ${meddelande(url)}
        <div class="kort">
          <dl>
            <dt>Inspelat</dt><dd>${inspelad(r.recorded_at)}</dd>
            <dt>Längd</dt><dd>${längd(r.duration)}</dd>
            <dt>Mål</dt><dd><a href="/admin/snack?mal=${encodeURIComponent(t)}">${r.target_name ?? t}</a></dd>
            <dt>Avsändare</dt><dd><a href="/admin/snack?avsandare=${encodeURIComponent(a)}">${r.sender_name ?? a}</a></dd>
            ${r.language ? html`<dt>Språk</dt><dd>${r.language}</dd>` : ""}
            ${taggar.length ? html`<dt>Taggar</dt><dd>${taggar.map((x) => html`<span class="tagg">${x}</span>`)}</dd>` : ""}
            <dt>Mottaget</dt><dd>${tidpunkt(r.received_at)}${r.sends > 1 ? html`, senast ${tidpunkt(r.updated_at)} (${r.sends} sändningar)` : ""}</dd>
            <dt>Id</dt><dd><code>${t}/${a}/${id}</code></dd>
          </dl>
        </div>
        ${ljud ? html`<audio controls preload="none" src="${filväg(ljud.key.slice(prefix.length))}"></audio>` : ""}
        <h2>Filer</h2>
        <ul>
          ${lista.objects.map((o) => {
            const namn = o.key.slice(prefix.length);
            return html`<li><a href="${filväg(namn)}?ladda=1">${namn}</a> <span class="dim">${storlek(o.size)}</span></li>`;
          })}
        </ul>
        ${sammanfattningar}
        ${brödtext ? html`<h2>Text</h2><pre class="text">${brödtext}</pre>` : html`<p class="dim">Ingen text mottagen.</p>`}
        <form method="post" action="/admin/snack${vägTill(t, a, id)}/ta-bort" class="rad"
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
      html`<h1>Mål</h1>
        <p class="dim">Mål är det avsändaren väljer i appen: kund, projekt, mapp. Id:t är fast (filerna sparas under det).</p>
        ${meddelande(url)} ${felruta(fel)}
        ${mål.map((m) => {
          const r = räkning.get(m.id);
          return html`<div class="kort">
            <form method="post" action="/admin/mal/${encodeURIComponent(m.id)}">
              <div><code>${m.id}</code> <span class="dim">· ${r?.avs ?? 0} avsändare · <a href="/admin/snack?mal=${encodeURIComponent(m.id)}">${r?.snack ?? 0} snack</a></span></div>
              <label>Namn</label><input type="text" name="name" value="${m.name}" required />
              <label>Grupp <span class="dim">(valfri)</span></label><input type="text" name="group" value="${m.grp ?? ""}" />
              <div class="rad"><button>Spara</button></div>
            </form>
            <form method="post" action="/admin/mal/${encodeURIComponent(m.id)}/ta-bort" class="rad"
              onsubmit="return confirm('Ta bort målet? Mottagna snack ligger kvar.')">
              <button class="farlig">Ta bort</button>
            </form>
          </div>`;
        })}
        ${mål.length ? "" : html`<p class="dim">Inga mål än.</p>`}
        <h2>Nytt mål</h2>
        <form method="post" action="/admin/mal" class="kort">
          <label>Namn</label><input type="text" name="name" required placeholder="Inkorg" />
          <label>Id <span class="dim">(valfritt, gemener, siffror, - _ .; annars av namnet)</span></label>
          <input type="text" name="id" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" placeholder="inbox" />
          <label>Grupp <span class="dim">(valfri)</span></label><input type="text" name="group" placeholder="Kunder" />
          <div class="rad"><button>Skapa mål</button></div>
        </form>`,
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
  if (!mål.length) return html`<p class="dim">Inga mål än. <a href="/admin/mal">Skapa ett mål</a> först.</p>`;
  return html`${mål.map(
    (m) =>
      html`<label class="val"><input type="checkbox" name="targets" value="${m.id}"${raw(valda.includes(m.id) ? " checked" : "")} />
        ${m.name}${m.grp ? html` <span class="dim">(${m.grp})</span>` : ""}</label>`,
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
      html`<h1>Avsändare</h1>
        <p class="dim">Varje person som skickar till dig får en egen nyckel och ser bara de mål du tilldelar.</p>
        ${meddelande(url)} ${felruta(fel)}
        ${avsändare.map(
          (a) => html`<div class="kort">
            <form method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}">
              <div><code>${a.id}</code>
                <span class="dim">· ${a.key_hint ? html`nyckel …${a.key_hint}` : html`<strong>spärrad</strong>`}
                · skapad ${tidpunkt(a.created_at)} · <a href="/admin/snack?avsandare=${encodeURIComponent(a.id)}">snack</a></span></div>
              <label>Namn</label><input type="text" name="name" value="${a.name}" required />
              <label>Mål</label>${målVal(mål, a.targets)}
              <label>Prompter</label>${promptVal(prompter, prompterFör(a.id))}
              <div class="rad"><button>Spara</button></div>
            </form>
            <div class="rad">
              <form method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/ny-nyckel"
                onsubmit="return confirm('Skapa en ny nyckel? Den gamla slutar fungera.')">
                <button class="diskret">${a.key_hint ? "Ny nyckel" : "Ge en ny nyckel"}</button>
              </form>
              ${a.key_hint
                ? html`<form method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/sparra"
                    onsubmit="return confirm('Spärra avsändaren? Nyckeln slutar fungera direkt.')">
                    <button class="farlig">Spärra</button></form>`
                : html`<form method="post" action="/admin/avsandare/${encodeURIComponent(a.id)}/ta-bort"
                    onsubmit="return confirm('Ta bort avsändaren? Mottagna snack ligger kvar.')">
                    <button class="farlig">Ta bort</button></form>`}
            </div>
          </div>`,
        )}
        ${avsändare.length ? "" : html`<p class="dim">Inga avsändare än.</p>`}
        <h2>Ny avsändare</h2>
        <form method="post" action="/admin/avsandare" class="kort">
          <label>Namn</label><input type="text" name="name" required placeholder="Anna Andersson" />
          <label>Mål</label>${målVal(mål, mål.length === 1 ? [mål[0].id] : [])}
          <label>Prompter <span class="dim">(extern AI: sammanfattningar och chatt)</span></label>${promptVal(prompter, [])}
          <div class="rad"><button>Skapa och visa nyckel</button></div>
        </form>`,
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
      html`<h1>Nyckel för ${namn}</h1>
        <p class="meddelande"><strong>Nyckeln visas bara nu.</strong> Den sparas bara som hash och går inte att visa igen.
          Tappas den bort: skapa en ny under Avsändare.</p>
        <p>Be ${namn} lägga till en mottagare i Snicksnack och skanna koden, eller skicka länken nedan.</p>
        <div class="qr">${raw(qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true }))}</div>
        <div class="kort">
          <dl>
            <dt>Adress</dt><dd><code>${url.origin}</code></dd>
            <dt>Nyckel</dt><dd><code>${nyckel}</code></dd>
            <dt>Länk</dt><dd><code>${länk}</code></dd>
          </dl>
        </div>
        <p><a href="/admin/avsandare">Tillbaka till avsändarna</a></p>`,
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
      html`<h1>Inställningar</h1>
        <p class="dim">Det här visas i Snicksnack när någon kopplar mottagaren. Adress för appen: <code>${url.origin}</code></p>
        ${meddelande(url)} ${felruta(fel)}
        <form method="post" action="/admin/installningar" enctype="multipart/form-data" class="kort">
          <label for="namn">Namn</label>
          <input id="namn" type="text" name="name" value="${s.name}" required maxlength="60" />
          <label for="farg">Färg</label>
          <div class="rad" style="margin-top:0">
            <input id="farg" type="color" name="color" value="${s.color ?? STANDARDFÄRG}" />
            <label class="val"><input type="checkbox" name="no_color"${raw(s.color ? "" : " checked")} /> Ingen egen färg</label>
          </div>
          <label>Logga <span class="dim">(kvadratisk PNG, minst 256 px, högst 2 MB)</span></label>
          ${s.icon ? html`<div class="rad" style="margin-top:0"><img src="/icon.png?v=${ikonversion(s.icon)}" alt="" width="64" height="64" style="border-radius:12px" />
            <label class="val"><input type="checkbox" name="remove_icon" /> Ta bort loggan</label></div>` : ""}
          <input type="file" name="icon" accept="image/png" />
          <label>Vad appen ska skicka</label>
          ${DELAR.map(
            (d) => html`<label class="val"><input type="checkbox" name="accepts" value="${d}"${raw(s.accepts.includes(d) ? " checked" : "")} /> ${DELNAMN[d]}</label>`,
          )}
          <p class="dim">Utan ljud blir sändningarna små; ljud i Apple Lossless tar ungefär 66 MB per timme.</p>
          <h2>Fri fråga i chatten</h2>
          <p class="dim">När någon skriver en egen fråga i stället för att välja en prompt. Bara avsändare som har minst en
            chattprompt kan chatta. Tomt = samma leverantör och modell som deras första chattprompt.</p>
          <label for="chat_provider">Leverantör</label>
          <select id="chat_provider" name="chat_provider">
            <option value="">Som första chattprompten</option>
            ${leverantörer.map((l) => html`<option value="${l.id}"${raw(l.id === s.chatProvider ? " selected" : "")}>${l.name}</option>`)}
          </select>
          <label for="chat_model">Modell <span class="dim">(tom = leverantörens standard)</span></label>
          <input id="chat_model" type="text" name="chat_model" value="${s.chatModel ?? ""}" />
          <label for="chat_system">Systemtext <span class="dim">(tom = inbyggd; gäller också prompter utan egen systemtext)</span></label>
          <textarea id="chat_system" name="chat_system" rows="4">${s.chatSystem}</textarea>
          <div class="rad"><button>Spara</button></div>
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

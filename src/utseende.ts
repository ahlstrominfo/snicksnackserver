// Adminwebbens utseende: samma känsla som appen Snicksnack (ios/Sources/Design/Tema.swift i appens repo).
// Krämpapper och varm bläcksvart, aprikos som accent, serif för det människor sa och rundad sans för det
// webben säger. Allt ligger inline: ingen byggkedja och inga externa resurser.

import { html, raw, type Raw } from "./html";

// Loggan: två bubblor. Aprikos framför är rösten, bläck bakom är den som lyssnar (papper i mörkt läge).
const BUBBLA_BAK =
  "M826.997 392.999C844.138 512.722 738.641 617.851 592.997 626.999C470.14 611.453 366.783 503.244 358.997 392.999C344.269 265.512 451.245 160.49 592.997 158.999C695.185 156.27 799.273 260.967 826.997 392.999Z";
const BUBBLA_FRAM =
  "M626.502 556.342C636.492 713.274 535.525 801.236 381.502 801.342C283.508 812.139 130.424 685.317 124.002 556.342C124.002 451.343 288 293.843 381.502 311.342C504.925 329.611 614.02 440.184 626.502 556.342Z";

export const logga = (klass = "logga"): Raw =>
  raw(`<svg class="${klass}" viewBox="114 115 740 740" aria-hidden="true"><path class="l-bak" d="${BUBBLA_BAK}"/><path class="l-fram" d="${BUBBLA_FRAM}"/></svg>`);

/** Bara aprikosbubblan: tomlägen. */
export const bubbla = (): Raw =>
  raw(`<svg class="bubbla" viewBox="120 300 515 515" aria-hidden="true"><path class="l-fram" d="${BUBBLA_FRAM}"/></svg>`);

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 939 939"><style>.p{fill:#FBF5EC} .s{fill:#2A211C} @media (prefers-color-scheme:dark){.p{fill:#1A1411} .s{fill:#FBF5EC}}</style><rect class="p" width="939" height="939" rx="210"/><path class="s" d="${BUBBLA_BAK}"/><path fill="#E27B48" d="${BUBBLA_FRAM}"/></svg>`;
export const FAVICON = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

// ---------- Byggstenar ----------

/** Sidans rubrik: en per sida, med en kort rad under och ev. en tillbakalänk. */
export function rubrik(titel: string, ingress: Raw | string | null = null, tillbaka: { väg: string; namn: string } | null = null): Raw {
  return html`<div class="sidhuvud">
    ${tillbaka ? html`<a class="tillbaka" href="${tillbaka.väg}">‹ ${tillbaka.namn}</a>` : ""}
    <h1>${titel}</h1>
    ${ingress ? html`<p class="ingress">${ingress}</p>` : ""}
  </div>`;
}

/** Ett fält med etikett ovanför och ev. en kort rad hjälp under. */
export function fältrad(etikett: string, kontroll: Raw, tips: Raw | string | null = null): Raw {
  return html`<label class="falt"><span class="etikett">${etikett}</span>${kontroll}${tips ? html`<span class="tips">${tips}</span>` : ""}</label>`;
}

/** En grupp kryssrutor (visas som piller). */
export function valgrupp(etikett: string, val: Raw | Raw[], tips: Raw | string | null = null): Raw {
  return html`<fieldset class="falt"><legend class="etikett">${etikett}</legend><div class="valgrupp">${val}</div>${
    tips ? html`<span class="tips">${tips}</span>` : ""
  }</fieldset>`;
}

/** Ett av/på-val som en iOS-växel. */
export function växel(namn: string, text: string, på: boolean): Raw {
  return html`<label class="vaxel"><span>${text}</span><input type="checkbox" name="${namn}"${raw(på ? " checked" : "")} /></label>`;
}

export const tomt = (text: Raw | string): Raw => html`<div class="tomt">${bubbla()}<p>${text}</p></div>`;

// ---------- Stilmall ----------

export const STIL = `
:root {
  --papper: #FBF5EC; --kort: #F1E6D6; --falt: #FBF5EC; --blck: #2A211C; --blck2: #5E4F45; --utkast: #7A6A5E;
  --linje: rgba(42,33,28,.12); --linje2: rgba(42,33,28,.22);
  --aprikos: #E27A48; --accent: #A8481E; --paaprikos: #2A1208; --rost: #A8432B; --glod: rgba(226,122,72,.18);
  --t0: #4F7A5A; --t1: #8A4F76; --t2: #A06E12; --t3: #2F6F8C; --t4: #5F5A9E; --t5: #6B5B4F;
  --serif: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
  --sans: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --papper: #1A1411; --kort: #2A211B; --falt: #1F1814; --blck: #F4EADF; --blck2: #BFAE9F; --utkast: #948375;
    --linje: rgba(244,234,223,.12); --linje2: rgba(244,234,223,.24);
    --aprikos: #EE8C58; --accent: #F4A57A; --rost: #E07A62; --glod: rgba(238,140,88,.20);
    --t0: #8DB596; --t1: #C98DB5; --t2: #D9A548; --t3: #7DB6CF; --t4: #A9A3E0; --t5: #C4B3A3;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--papper); color: var(--blck); font: 17px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 3px solid var(--glod); outline-offset: 2px; }
.logga { width: 30px; height: 30px; flex: none; }
.l-bak { fill: var(--blck); }
.l-fram { fill: #E27B48; }

/* Sidhuvud: glas över pappret, loggan och navigeringen */
.topp { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--papper) 84%, transparent);
  -webkit-backdrop-filter: saturate(1.5) blur(18px); backdrop-filter: saturate(1.5) blur(18px); border-bottom: 1px solid var(--linje); }
.topp .inre { max-width: 760px; margin: 0 auto; padding: 10px 16px 8px; }
.topprad { display: flex; align-items: center; gap: 12px; min-height: 40px; }
.marke { display: flex; align-items: center; gap: 10px; min-width: 0; margin-right: auto; color: var(--blck);
  font: 600 1.1rem/1.2 var(--serif); }
.marke:hover { text-decoration: none; }
.marke span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topp form { margin: 0; }
nav.flikar { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; margin: 6px -10px 0; padding: 0 0 2px; }
nav.flikar::-webkit-scrollbar { display: none; }
@media (max-width: 640px) { nav.flikar { -webkit-mask-image: linear-gradient(to right, #000 88%, transparent); mask-image: linear-gradient(to right, #000 88%, transparent); } }
nav.flikar a { padding: 6px 12px; border-radius: 999px; color: var(--blck2); font-weight: 600; font-size: .95rem; white-space: nowrap; }
nav.flikar a:hover { color: var(--blck); text-decoration: none; }
nav.flikar a[aria-current] { background: var(--kort); color: var(--blck); }

main { max-width: 760px; margin: 0 auto; padding: 0 16px 72px; }
.sidhuvud { margin: 28px 4px 22px; }
.tillbaka { display: inline-block; font-weight: 600; margin-bottom: 8px; }
h1 { font: 600 2.1rem/1.12 var(--serif); letter-spacing: -.01em; margin: 0; overflow-wrap: anywhere; }
.ingress { color: var(--blck2); margin: 8px 0 0; font-size: 1rem; }
h2 { font: 700 .95rem/1.3 var(--sans); color: var(--blck2); margin: 30px 6px 10px; }
h3 { font: 700 1rem/1.3 var(--sans); margin: 18px 0 6px; }
p { margin: 0 0 12px; }
.dim { color: var(--blck2); font-weight: 400; }
code { font: .84em/1.4 var(--mono); background: color-mix(in srgb, var(--blck) 7%, transparent); padding: 2px 6px; border-radius: 6px; overflow-wrap: anywhere; }

/* Kort och listor */
.kort { background: var(--kort); border-radius: 22px; padding: 18px; margin: 0 0 14px; }
.kort > :last-child, .kort > fieldset:last-child > :last-child { margin-bottom: 0; }
.lista { background: var(--kort); border-radius: 22px; margin: 0 0 14px; overflow: hidden; }
.lista > * + * { border-top: 1px solid var(--linje); }
.post > summary, a.radlank { display: flex; align-items: center; gap: 12px; padding: 14px 18px; color: inherit; cursor: pointer; list-style: none; }
.post > summary::-webkit-details-marker { display: none; }
a.radlank:hover, .post > summary:hover { background: color-mix(in srgb, var(--blck) 4%, transparent); text-decoration: none; }
.radtext { flex: 1; min-width: 0; }
.radtopp { display: flex; align-items: baseline; gap: 12px; }
.namn { font-weight: 650; overflow-wrap: anywhere; }
.radtopp time { margin-left: auto; color: var(--blck2); font-weight: 600; font-size: .9rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.meta { color: var(--blck2); font-size: .88rem; margin-top: 2px; overflow-wrap: anywhere; }
.chev { color: var(--utkast); font-size: 1.3rem; line-height: 1; transition: transform .2s; flex: none; }
.post[open] > summary .chev { transform: rotate(90deg); }
.post > .postinnehall { padding: 4px 18px 18px; }
.nyckelrad { display: flex; align-items: center; gap: 12px; padding: 12px 10px 12px 18px; }
.ny { margin-top: 8px; }
.ny > summary { color: var(--accent); font-weight: 650; }
.ny > summary .plus { font-size: 1.3rem; line-height: 1; }
.dag { margin-top: 26px; }

/* Formulär som iOS-inställningar */
form { margin: 0; }
fieldset { border: 0; padding: 0; min-width: 0; }
.falt { display: block; margin: 0 0 16px; }
.etikett { display: block; font-weight: 650; font-size: .88rem; color: var(--blck2); margin: 0 0 6px 2px; padding: 0; }
.tips { display: block; font-size: .84rem; color: var(--blck2); margin: 6px 2px 0; }
input[type=text], input[type=password], select, textarea { font: inherit; font-size: 1rem; width: 100%; padding: 11px 14px;
  border-radius: 12px; border: 1px solid var(--linje); background: var(--falt); color: var(--blck); }
input::placeholder, textarea::placeholder { color: var(--utkast); opacity: 1; }
input[type=text]:focus, input[type=password]:focus, select:focus, textarea:focus { outline: none; border-color: var(--aprikos); box-shadow: 0 0 0 3px var(--glod); }
textarea { line-height: 1.45; resize: vertical; min-height: 88px; }
select { -webkit-appearance: none; appearance: none; padding-right: 38px; cursor: pointer;
  background: var(--falt) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23948375' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 14px center; }
input[type=file] { font: inherit; font-size: .92rem; color: var(--blck2); max-width: 100%; }
input[type=file]::file-selector-button { font: 600 .92rem var(--sans); border: 0; border-radius: 999px; padding: 8px 14px; margin-right: 10px;
  background: var(--falt); color: var(--accent); cursor: pointer; }
input[type=color] { width: 52px; height: 40px; padding: 3px; border: 1px solid var(--linje); border-radius: 12px; background: var(--falt); cursor: pointer; }
.valgrupp { display: flex; flex-wrap: wrap; gap: 8px; }
label.val { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: var(--falt);
  border: 1px solid var(--linje); font-size: .95rem; cursor: pointer; }
label.val input { accent-color: var(--aprikos); width: 17px; height: 17px; margin: 0; }
label.val:has(input:checked) { background: var(--glod); border-color: color-mix(in srgb, var(--aprikos) 50%, transparent); }
label.vaxel { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 0 0 16px; cursor: pointer; }
label.vaxel input { -webkit-appearance: none; appearance: none; flex: none; width: 51px; height: 31px; margin: 0; border-radius: 999px;
  background: var(--linje2); position: relative; cursor: pointer; transition: background .2s; }
label.vaxel input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%;
  background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,.22); transition: transform .2s; }
label.vaxel input:checked { background: var(--aprikos); }
label.vaxel input:checked::after { transform: translateX(20px); }
.sidvid { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.sidvid > label.vaxel { margin: 0; flex: 1; }

/* Knappar: en fylld per kort, resten som text */
button, .knapp { font: 650 1rem/1.2 var(--sans); display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 11px 22px; border: 0; border-radius: 999px; background: var(--aprikos); color: var(--paaprikos);
  cursor: pointer; text-decoration: none; }
button:hover, .knapp:hover { filter: brightness(1.05); text-decoration: none; }
button:active, .knapp:active { transform: scale(.98); }
button.diskret, .knapp.diskret { background: transparent; color: var(--accent); padding: 11px 12px; }
button.farlig { background: transparent; color: var(--rost); padding: 11px 12px; }
button.diskret:hover, button.farlig:hover { background: color-mix(in srgb, currentColor 9%, transparent); filter: none; }
button.liten { min-height: 34px; padding: 6px 12px; font-size: .92rem; }
.knappar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 20px; }
.knappar .hoger { margin-left: auto; display: flex; flex-wrap: wrap; gap: 2px; }
.bred { width: 100%; }

/* Besked */
.meddelande { background: var(--glod); border-radius: 16px; padding: 12px 16px; margin: 0 0 16px; font-weight: 600; }
.fel { background: color-mix(in srgb, var(--rost) 14%, var(--papper)); color: var(--rost); border-radius: 16px; padding: 12px 16px; margin: 0 0 16px; font-weight: 600; }
.tomt { text-align: center; color: var(--blck2); padding: 34px 20px 26px; }
.tomt p { margin: 0; }
.bubbla { width: 54px; height: 54px; display: block; margin: 0 auto 14px; }

/* Snacket */
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip { display: inline-block; padding: 4px 12px; border-radius: 999px; background: var(--kort); color: var(--blck); font-size: .88rem; font-weight: 600; }
a.chip:hover { text-decoration: none; background: var(--glod); }
.chip.tagg { background: transparent; border: 1px solid var(--linje2); color: var(--blck2); }
.spelare { padding: 12px 14px; }
audio { width: 100%; display: block; }
.flikvy > input { position: absolute; opacity: 0; pointer-events: none; }
.segment { display: flex; background: var(--kort); border-radius: 999px; padding: 4px; margin: 4px 0 22px; }
.segment label { flex: 1; text-align: center; padding: 8px 10px; border-radius: 999px; font-weight: 650; color: var(--blck2); cursor: pointer; }
#vy-t:checked ~ .segment label[for=vy-t], #vy-s:checked ~ .segment label[for=vy-s] { background: var(--papper); color: var(--blck); box-shadow: 0 1px 4px rgba(42,33,28,.12); }
#vy-t:focus-visible ~ .segment label[for=vy-t], #vy-s:focus-visible ~ .segment label[for=vy-s] { outline: 3px solid var(--glod); }
#vy-s:checked ~ .panel-t, #vy-t:checked ~ .panel-s { display: none; }
.transkript { font: 1.2rem/1.6 var(--serif); margin: 0 4px; overflow-wrap: break-word; }
.transkript p { margin: 0 0 10px; }
.replik { margin: 0 0 20px; }
.talare { display: flex; align-items: center; gap: 8px; font: 650 .9rem/1.3 var(--sans); color: var(--tc, var(--blck2)); margin: 0 0 3px; }
.talare::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: currentColor; flex: none; }
.t0 { --tc: var(--t0); } .t1 { --tc: var(--t1); } .t2 { --tc: var(--t2); } .t3 { --tc: var(--t3); } .t4 { --tc: var(--t4); } .t5 { --tc: var(--t5); }
.tid { font: 650 .85rem var(--sans); font-variant-numeric: tabular-nums; color: var(--blck2); }
button.tid { background: none; border: 0; padding: 0; min-height: 0; border-radius: 4px; }
button.tid:hover { color: var(--accent); filter: none; }
.sammanfattning { background: var(--kort); border-radius: 22px; padding: 18px 20px; margin: 0 0 14px; }
.sammanfattning h3:first-of-type { margin-top: 6px; }
.maskin { display: flex; justify-content: space-between; gap: 10px; font-size: .78rem; letter-spacing: .05em; text-transform: uppercase; font-weight: 700; color: var(--blck2); }
.punkter { margin: 0; padding-left: 1.2em; }
.punkter li { margin: 5px 0; }
.punkter.citat { list-style: none; padding: 0; font: 1.12rem/1.5 var(--serif); }
.punkter.citat li { border-left: 3px solid var(--aprikos); padding-left: 12px; margin: 10px 0; }
.punkter .tid { margin-left: 6px; padding: 1px 8px; border-radius: 999px; background: var(--papper); }
pre.text { white-space: pre-wrap; font: .88rem/1.55 var(--mono); background: var(--falt); border-radius: 14px; padding: 14px; margin: 12px 0 0; max-height: 70vh; overflow: auto; }
.inlagt > summary { font-weight: 650; color: var(--accent); cursor: pointer; }
dl.fakta { margin: 0; }
dl.fakta > div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 11px 0; }
dl.fakta > div + div { border-top: 1px solid var(--linje); }
dl.fakta dt { color: var(--blck2); flex: none; }
dl.fakta dd { margin: 0; text-align: right; min-width: 0; overflow-wrap: anywhere; }
.fil { font-variant-numeric: tabular-nums; }
.tabell { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .95rem; }
th, td { text-align: left; padding: 11px 16px; vertical-align: top; }
tr + tr td, tbody tr:first-child td { border-top: 1px solid var(--linje); }
th { font-size: .8rem; color: var(--blck2); font-weight: 700; white-space: nowrap; }
td.tal, th.tal { text-align: right; }

/* QR-vyn och inloggningen */
.lugn { max-width: 440px; margin: 0 auto; text-align: center; }
.lugn .sidhuvud { margin-top: 40px; }
.qr { background: #fff; padding: 18px; border-radius: 28px; width: min(300px, 100%); margin: 6px auto 22px; box-shadow: 0 12px 34px rgba(42,33,28,.14); }
.qr svg { width: 100%; height: auto; display: block; }
.lugn .kort, .lugn .meddelande { text-align: left; }
.lugn .knappar { justify-content: center; }
.stor-logga { width: 76px; height: 76px; display: block; margin: 0 auto 4px; }

.filter { display: flex; gap: 8px; align-items: center; margin: 0 0 4px; }
.filter select { flex: 1; min-width: 0; width: auto; padding: 8px 34px 8px 14px; font-size: .92rem; border-radius: 999px; background-color: var(--kort); border-color: transparent; }
.forhand { display: flex; align-items: center; gap: 14px; margin: 0 0 20px; }
.forhand img, .forhand .logga { width: 52px; height: 52px; border-radius: 12px; flex: none; }
.anteckning { font: 1.1rem/1.5 var(--serif); margin: 8px 0 0; white-space: pre-wrap; }

@media (max-width: 520px) {
  body { font-size: 16px; }
  h1 { font-size: 1.85rem; }
  .sidhuvud { margin: 22px 2px 18px; }
  .kort { padding: 16px; border-radius: 20px; }
  .post > summary, a.radlank { padding: 13px 16px; }
  .post > .postinnehall { padding: 2px 16px 16px; }
  .transkript { font-size: 1.15rem; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** Liten hjälp på snackets sida: tidkoder spelar upp ljudet därifrån, och kopiera-knappar. */
export const SKRIPT = `
const aktiv = document.querySelector("nav.flikar [aria-current]");
if (aktiv) aktiv.parentElement.scrollLeft = aktiv.offsetLeft - aktiv.parentElement.offsetLeft - 24;
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-t]");
  const ljud = document.querySelector("audio");
  if (t && ljud) { ljud.currentTime = Number(t.dataset.t); ljud.play(); ljud.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  const k = e.target.closest("[data-kopiera]");
  if (k && navigator.clipboard) navigator.clipboard.writeText(k.dataset.kopiera).then(() => { k.textContent = "Kopierat"; });
});
// Bekräftelse före farliga formulär (inga inline-händelser: CSP tillåter bara skript med nonce).
document.addEventListener("submit", (e) => {
  const t = e.target.dataset && e.target.dataset.bekrafta;
  if (t && !confirm(t)) e.preventDefault();
});
`;

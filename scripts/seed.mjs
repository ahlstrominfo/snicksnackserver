#!/usr/bin/env node
// Lägger in ett mål "inbox" och en avsändare med alla mål, och skriver ut nyckeln en gång.
//
//   npm run seed                      lokalt (wrangler dev), avsändaren heter "Testavsändare"
//   npm run seed -- "Anna" --remote   på Cloudflare
//   npm run seed -- --url https://mottagare.example.se   adressen i QR-länken (standard http://localhost:8787)
//
// Migreringarna körs först (de som redan körts hoppas över).

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const arg = process.argv.slice(2);
const remote = arg.includes("--remote");
const urlIndex = arg.indexOf("--url");
const bas = urlIndex >= 0 ? arg[urlIndex + 1] : "http://localhost:8787";
const namn = arg.find((a, i) => !a.startsWith("--") && arg[i - 1] !== "--url") ?? "Testavsändare";
const plats = remote ? "--remote" : "--local";

function wrangler(...a) {
  return execFileSync("npx", ["wrangler", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;

wrangler("d1", "migrations", "apply", "DB", plats);

const slug =
  namn
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "avsandare";
const id = `${slug}-${randomBytes(2).toString("hex")}`;
const nyckel = "ssk_" + randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(nyckel).digest("hex");
const nu = new Date().toISOString();

wrangler(
  "d1",
  "execute",
  "DB",
  plats,
  "--command",
  [
    `INSERT OR IGNORE INTO targets (id, name, grp, created_at) VALUES ('inbox', 'Inkorg', NULL, ${sql(nu)})`,
    `INSERT INTO senders (id, name, key_hash, key_hint, created_at) VALUES (${sql(id)}, ${sql(namn)}, ${sql(hash)}, ${sql(nyckel.slice(-4))}, ${sql(nu)})`,
    `INSERT INTO sender_targets (sender_id, target_id) SELECT ${sql(id)}, id FROM targets`,
  ].join("; "),
);

console.log(`
Avsändare: ${namn} (${id}), tilldelad alla mål
Nyckel:    ${nyckel}
Länk:      snicksnack://receiver?url=${bas}&key=${nyckel}

Prova:
  curl ${bas}/.well-known/snicksnack
  curl -H "Authorization: Bearer ${nyckel}" ${bas}/snicksnack/targets
`);

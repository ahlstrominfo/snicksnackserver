// Snicksnack-mottagaren: en Cloudflare Worker som tar emot snack från appen Snicksnack.
// Protokollet: docs/protokoll.md. Admin: /admin.

import { admin } from "./admin";
import { ljud, mcp } from "./mcp";
import { minSida } from "./min";
import { chatta, listaPrompter, sammanfatta } from "./ai/anrop";
import { fel, ikon, receive, targets, wellKnown } from "./protokoll";

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    const metod = req.method;
    try {
      if (pathname === "/.well-known/snicksnack") {
        return metod === "GET" || metod === "HEAD" ? await wellKnown(req, env) : fel(405, "Bara GET");
      }
      if (pathname === "/snicksnack/targets") {
        return metod === "GET" ? await targets(req, env) : fel(405, "Bara GET");
      }
      if (pathname.startsWith("/snicksnack/receive/")) {
        const mål = pathname.slice("/snicksnack/receive/".length);
        if (!mål || mål.includes("/")) return fel(404, "Okänt mål");
        return metod === "POST" ? await receive(req, env, ctx, mål) : fel(405, "Bara POST");
      }
      if (pathname === "/snicksnack/summarize") {
        return metod === "GET" ? await listaPrompter(req, env) : fel(405, "Bara GET");
      }
      if (pathname.startsWith("/snicksnack/summarize/")) {
        const id = pathname.slice("/snicksnack/summarize/".length);
        if (!id || id.includes("/")) return fel(404, "Okänd prompt");
        return metod === "POST" ? await sammanfatta(req, env, ctx, id) : fel(405, "Bara POST");
      }
      if (pathname === "/snicksnack/chat") {
        return metod === "POST" ? await chatta(req, env, ctx) : fel(405, "Bara POST");
      }
      if (pathname === "/mcp") return await mcp(req, env, ctx);
      if (pathname.startsWith("/ljud/")) {
        return metod === "GET" || metod === "HEAD" ? await ljud(req, env, pathname.slice("/ljud/".length)) : fel(405, "Bara GET");
      }
      if (pathname.startsWith("/min/")) {
        let delar: string[];
        try {
          delar = pathname.slice("/min/".length).replace(/\/+$/, "").split("/").map(decodeURIComponent);
        } catch {
          return fel(404, "Finns inte");
        }
        return await minSida(req, env, delar);
      }
      if (pathname === "/icon.png") {
        return metod === "GET" || metod === "HEAD" ? await ikon(req, env) : fel(405, "Bara GET");
      }
      if (pathname === "/admin" || pathname.startsWith("/admin/")) return await admin(req, env);
      if (pathname === "/") return Response.redirect(new URL("/admin", req.url).toString(), 302);
      return fel(404, "Finns inte");
    } catch (e) {
      console.error("Fel i", metod, pathname, e);
      return fel(500, "Internt fel");
    }
  },
} satisfies ExportedHandler<Env>;

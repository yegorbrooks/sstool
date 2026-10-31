const MAX_FILE = 50 * 1024 * 1024;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname, url = new URL(req.url);
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (p === "/api/cases" && req.method === "GET") {
        const { results } = await env.DB.prepare("SELECT data FROM cases").all();
        return json(results.map((r) => JSON.parse(r.data)));
      }
      let m = p.match(/^\/api\/cases\/([\w-]+)$/);
      if (m && req.method === "PUT") {
        const body = await req.json();
        body.id = m[1];
        await env.DB.prepare(
          "INSERT INTO cases (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3"
        ).bind(m[1], JSON.stringify(body), Date.now()).run();
        return json({ ok: true });
      }
      if (m && req.method === "DELETE") {
        const row = await env.DB.prepare("SELECT data FROM cases WHERE id = ?1").bind(m[1]).first();
        if (row) {
          const docs = (JSON.parse(row.data).docs || []).map((d) => d.id).filter(Boolean);
          if (docs.length) await env.FILES.delete(docs);
        }
        await env.DB.prepare("DELETE FROM cases WHERE id = ?1").bind(m[1]).run();
        return json({ ok: true });
      }
      if (p === "/api/files" && req.method === "POST") {
        const len = Number(req.headers.get("content-length") || 0);
        if (!len) return json({ error: "Empty file", code: "invalid_request" }, 400);
        if (len > MAX_FILE) return json({ error: "File too large", code: "too_large" }, 413);
        const id = crypto.randomUUID();
        const type = req.headers.get("content-type") || "application/octet-stream";
        const name = decodeURIComponent(req.headers.get("x-filename") || "file");
        await env.FILES.put(id, req.body, { httpMetadata: { contentType: type }, customMetadata: { name } });
        return json({ id, sizeBytes: len, contentType: type });
      }
      m = p.match(/^\/api\/files\/([0-9a-f-]{36})$/);
      if (m && req.method === "GET") {
        const obj = await env.FILES.get(m[1]);
        if (!obj) return json({ error: "Not found" }, 404);
        const name = (obj.customMetadata && obj.customMetadata.name) || "file";
        const h = new Headers();
        h.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
        h.set("content-disposition", (url.searchParams.get("download") ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(name));
        h.set("x-content-type-options", "nosniff");
        h.set("content-security-policy", "sandbox"); // uploaded HTML or SVG can never run scripts on this site
        h.set("cache-control", "private, max-age=3600");
        return new Response(obj.body, { headers: h });
      }
      if (m && req.method === "DELETE") {
        await env.FILES.delete(m[1]);
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Server error" }, 500);
    }
  },
};

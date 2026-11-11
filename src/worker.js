const MAX_FILE = 50 * 1024 * 1024;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

/* ---------- Cloudflare Access: verify the signed login token ---------- */
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = (s) => JSON.parse(new TextDecoder().decode(b64(s)));

// Returns the signed-in user's email, or null if the request is not from an allowed Access login.
async function accessUser(req, env) {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const [h, p, s] = token.split(".");
    const header = parse(h), claims = parse(p);
    if (header.alg !== "RS256") return null;
    const jwks = await (await fetch(env.TEAM_DOMAIN + "/cdn-cgi/access/certs", { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(s), new TextEncoder().encode(h + "." + p));
    const aud = [].concat(claims.aud);
    const email = String(claims.email || "").toLowerCase();
    const now = Date.now() / 1000;
    if (!ok) return null;
    if (claims.iss !== env.TEAM_DOMAIN) return null;
    if (!aud.includes(env.POLICY_AUD)) return null;
    if (!(claims.exp > now)) return null;
    if (claims.nbf && claims.nbf > now + 60) return null;
    if (!email.endsWith(String(env.ALLOWED_DOMAIN || "").toLowerCase())) return null;
    return email;
  } catch (e) {
    return null;
  }
}

// Credits a save to the signed-in user. History entries and documents already saved keep
// their author; anything new in this save is credited to whoever is saving now.
function stampAuthor(body, old, user) {
  const kept = old && Array.isArray(old.history) ? old.history : [];
  const sent = Array.isArray(body.history) ? body.history : [];
  body.history = kept.concat(sent.slice(kept.length).map((h) => Object.assign({}, h, { by: user })));
  const oldDocs = new Map(((old && old.docs) || []).map((d) => [d.id, d]));
  body.docs = (body.docs || []).map((d) => Object.assign({}, d, { by: oldDocs.has(d.id) ? oldDocs.get(d.id).by : user }));
  body.createdBy = old ? old.createdBy || "" : user;
  body.updatedBy = user;
  body.updatedAt = Date.now();
}

function decodeName(s) {
  try { return decodeURIComponent(s || "file") || "file"; } catch (e) { return "file"; }
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname, url = new URL(req.url);
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);

    // Every API call needs a valid @flyluxury.com login.
    // Local development only: DEV=1 in .dev.vars skips the check, and only when running on localhost,
    // so a stray DEV variable in production can never switch sign-in off.
    let user = env.DEV_USER || "dev@localhost";
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!(env.DEV === "1" && local)) {
      user = await accessUser(req, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
    }

    try {
      if (p === "/api/me" && req.method === "GET") return json({ email: user });
      if (p === "/api/cases" && req.method === "GET") {
        const { results } = await env.DB.prepare("SELECT data, updated_at FROM cases").all();
        // _v is the case's version: the browser sends it back when saving so we can spot overwrites.
        return json(results.map((r) => Object.assign(JSON.parse(r.data), { _v: r.updated_at })).filter((c) => !c.deleted));
      }
      let m = p.match(/^\/api\/cases\/([\w-]+)$/);
      if (m && req.method === "PUT") {
        const base = req.headers.get("x-version");
        // Every save must say which version it was based on, so nothing is overwritten unseen.
        if (!base) return json({ error: "Reload the page to get the latest version", code: "conflict" }, 409);
        const body = await req.json();
        body.id = m[1];
        delete body._v;
        // Only the delete endpoint may mark a case deleted.
        delete body.deleted; delete body.deletedBy; delete body.deletedAt;
        const row = await env.DB.prepare("SELECT data FROM cases WHERE id = ?1").bind(m[1]).first();
        const old = row ? JSON.parse(row.data) : null;
        if (old && old.deleted) return json({ error: "This case was deleted", code: "conflict" }, 409);
        stampAuthor(body, old, user);
        const data = JSON.stringify(body);
        const v = Math.max(Date.now(), (Number(base) || 0) + 1);
        if (base === "new") {
          // A new case: never replace an existing one.
          const r = await env.DB.prepare(
            "INSERT INTO cases (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING"
          ).bind(m[1], data, v).run();
          if (!r.meta.changes) return json({ error: "A case with this id already exists", code: "conflict" }, 409);
        } else {
          // An existing case: save only if nobody else saved it since this browser loaded it.
          const r = await env.DB.prepare(
            "UPDATE cases SET data = ?2, updated_at = ?3 WHERE id = ?1 AND updated_at = ?4"
          ).bind(m[1], data, v, Number(base)).run();
          if (!r.meta.changes) return json({ error: "The case was changed or deleted by someone else", code: "conflict" }, 409);
        }
        return json({ ok: true, v, case: body });
      }
      if (m && req.method === "DELETE") {
        const row = await env.DB.prepare("SELECT data, updated_at FROM cases WHERE id = ?1").bind(m[1]).first();
        if (!row) return json({ error: "Not found" }, 404);
        const data = JSON.parse(row.data);
        if (data.deleted) return json({ ok: true });
        // Soft delete: the case and its files stay stored, with who deleted it and when.
        data.deleted = true;
        data.deletedBy = user;
        data.deletedAt = Date.now();
        data.history = (data.history || []).concat([{ at: new Date().toISOString().slice(0, 10), text: "Case deleted.", by: user }]);
        const v = Math.max(Date.now(), row.updated_at + 1);
        const r = await env.DB.prepare(
          "UPDATE cases SET data = ?2, updated_at = ?3 WHERE id = ?1 AND updated_at = ?4"
        ).bind(m[1], JSON.stringify(data), v, row.updated_at).run();
        if (!r.meta.changes) return json({ error: "The case was changed by someone else", code: "conflict" }, 409);
        return json({ ok: true });
      }
      if (p === "/api/files" && req.method === "POST") {
        const len = Number(req.headers.get("content-length") || 0);
        if (!len) return json({ error: "Empty file", code: "invalid_request" }, 400);
        if (len > MAX_FILE) return json({ error: "File too large", code: "too_large" }, 413);
        const id = crypto.randomUUID();
        const type = req.headers.get("content-type") || "application/octet-stream";
        const name = decodeName(req.headers.get("x-filename"));
        await env.FILES.put(id, req.body, { httpMetadata: { contentType: type }, customMetadata: { name, by: user } });
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
        // Only for cleaning up uploads that were never saved to a case:
        // the uploader can delete their own file, and only while no case (deleted ones included) lists it.
        const head = await env.FILES.head(m[1]);
        if (!head) return json({ ok: true });
        if ((head.customMetadata || {}).by !== user) return json({ error: "Forbidden" }, 403);
        const ref = await env.DB.prepare("SELECT 1 FROM cases WHERE data LIKE ?1 LIMIT 1").bind('%"' + m[1] + '"%').first();
        if (ref) return json({ error: "File is attached to a case", code: "conflict" }, 409);
        await env.FILES.delete(m[1]);
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
};
import { json, MAX_FILE } from "./http.js";

function decodeName(s) {
  try { return decodeURIComponent(s || "file") || "file"; } catch (e) { return "file"; }
}

// POST /api/files
export async function uploadFile(req, env, user) {
  const len = Number(req.headers.get("content-length") || 0);
  if (!len) return json({ error: "Empty file", code: "invalid_request" }, 400);
  if (len > MAX_FILE) return json({ error: "File too large", code: "too_large" }, 413);
  const id = crypto.randomUUID();
  const type = req.headers.get("content-type") || "application/octet-stream";
  const name = decodeName(req.headers.get("x-filename"));
  await env.FILES.put(id, req.body, { httpMetadata: { contentType: type }, customMetadata: { name, by: user } });
  return json({ id, sizeBytes: len, contentType: type });
}

// GET /api/files/:id  (?download=1 to save instead of view)
export async function getFile(env, id, url) {
  const obj = await env.FILES.get(id);
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

// DELETE /api/files/:id
// Only for cleaning up uploads that were never saved to a case:
// the uploader can delete their own file, and only while no case (deleted ones included) lists it.
export async function deleteFile(env, user, id) {
  const head = await env.FILES.head(id);
  if (!head) return json({ ok: true });
  if ((head.customMetadata || {}).by !== user) return json({ error: "Forbidden" }, 403);
  const ref = await env.DB.prepare("SELECT 1 FROM cases WHERE data LIKE ?1 LIMIT 1").bind('%"' + id + '"%').first();
  if (ref) return json({ error: "File is attached to a case", code: "conflict" }, 409);
  await env.FILES.delete(id);
  return json({ ok: true });
}

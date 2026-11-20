import { json } from "./http.js";

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

// GET /api/cases
export async function listCases(env) {
  const { results } = await env.DB.prepare("SELECT data, updated_at FROM cases").all();
  // _v is the case's version: the browser sends it back when saving so we can spot overwrites.
  return json(results.map((r) => Object.assign(JSON.parse(r.data), { _v: r.updated_at })).filter((c) => !c.deleted));
}

// PUT /api/cases/:id
export async function saveCase(req, env, user, id) {
  const base = req.headers.get("x-version");
  // Every save must say which version it was based on, so nothing is overwritten unseen.
  if (!base) return json({ error: "Reload the page to get the latest version", code: "conflict" }, 409);
  const body = await req.json();
  body.id = id;
  delete body._v;
  // Only the delete endpoint may mark a case deleted.
  delete body.deleted; delete body.deletedBy; delete body.deletedAt;
  const row = await env.DB.prepare("SELECT data FROM cases WHERE id = ?1").bind(id).first();
  const old = row ? JSON.parse(row.data) : null;
  if (old && old.deleted) return json({ error: "This case was deleted", code: "conflict" }, 409);
  stampAuthor(body, old, user);
  const data = JSON.stringify(body);
  const v = Math.max(Date.now(), (Number(base) || 0) + 1);
  if (base === "new") {
    // A new case: never replace an existing one.
    const r = await env.DB.prepare(
      "INSERT INTO cases (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING"
    ).bind(id, data, v).run();
    if (!r.meta.changes) return json({ error: "A case with this id already exists", code: "conflict" }, 409);
  } else {
    // An existing case: save only if nobody else saved it since this browser loaded it.
    const r = await env.DB.prepare(
      "UPDATE cases SET data = ?2, updated_at = ?3 WHERE id = ?1 AND updated_at = ?4"
    ).bind(id, data, v, Number(base)).run();
    if (!r.meta.changes) return json({ error: "The case was changed or deleted by someone else", code: "conflict" }, 409);
  }
  return json({ ok: true, v, case: body });
}

// DELETE /api/cases/:id
// Soft delete: the case and its files stay stored, with who deleted it and when.
export async function deleteCase(env, user, id) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM cases WHERE id = ?1").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404);
  const data = JSON.parse(row.data);
  if (data.deleted) return json({ ok: true });
  data.deleted = true;
  data.deletedBy = user;
  data.deletedAt = Date.now();
  data.history = (data.history || []).concat([{ at: new Date().toISOString().slice(0, 10), text: "Case deleted.", by: user }]);
  const v = Math.max(Date.now(), row.updated_at + 1);
  const r = await env.DB.prepare(
    "UPDATE cases SET data = ?2, updated_at = ?3 WHERE id = ?1 AND updated_at = ?4"
  ).bind(id, JSON.stringify(data), v, row.updated_at).run();
  if (!r.meta.changes) return json({ error: "The case was changed by someone else", code: "conflict" }, 409);
  return json({ ok: true });
}

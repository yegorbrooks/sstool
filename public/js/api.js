// Talking to the server: cases, files and the signed-in user.
import { state, app } from "./state.js";
import { $, toast } from "./util.js";
import { norm } from "./model.js";

// When the Cloudflare Access sign-in runs out, Access answers with a redirect to its login page.
// "manual" redirects let us spot that instead of failing with a confusing network error.
export function expiredErr() {
  var e = new Error("Your sign-in expired. Open the app in a new tab to sign in, then try again.");
  e.status = 401; e.code = "expired"; return e;
}
function isExpired(r) { return r.type === "opaqueredirect" || r.status === 401; }
function api(method, path, body, headers) {
  var opt = { method: method, headers: headers || {}, redirect: "manual" };
  if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
  return fetch(path, opt).then(function (r) {
    if (isExpired(r)) throw expiredErr();
    if (!r.ok) { var e = new Error("Server answered " + r.status); e.status = r.status; throw e; }
    return r.json();
  });
}

export function getMe() { return api("GET", "/api/me"); }

// Saves a case. The version (_v) it was loaded with goes along, so the server refuses
// the save (409) if someone else saved the case in the meantime.
export function saveCase(c) {
  c.updatedAt = Date.now();
  var ver = c._v != null ? String(c._v) : "new";
  return api("PUT", "/api/cases/" + encodeURIComponent(c.id), c, { "x-version": ver }).then(function (j) {
    var saved = j.case || c;
    saved._v = j.v; c._v = j.v;
    var i = state.cases.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) state.cases[i] = norm(saved); else state.cases.push(norm(saved));
    app.renderAll();
  }, function (e) {
    if (e.status === 401) toast(e.message, 8000);
    else if (e.status !== 409) toast("Could not save: " + e.message);
    throw e;
  });
}
export function removeCase(id) {
  return api("DELETE", "/api/cases/" + encodeURIComponent(id)).then(function () {
    state.cases = state.cases.filter(function (x) { return x.id !== id; });
    app.renderAll();
  }, function (e) { toast(e.status === 401 ? e.message : "Could not delete: " + e.message, e.status === 401 ? 8000 : 0); throw e; });
}
export function loadCases(first) {
  return api("GET", "/api/cases").then(function (list) {
    var wasExpired = state.expired;
    state.expired = false;
    // Nothing changed since the last refresh: leave the page alone.
    var sig = list.map(function (c) { return c.id + ":" + c._v; }).sort().join(",");
    if (!first && !wasExpired && sig === state.sig) return;
    state.sig = sig;
    state.cases = list.map(norm); state.loaded = true;
    // Don't redraw while someone has a dropdown or date picker open.
    var el = document.activeElement;
    var picking = el && (el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type === "date"));
    if (first) { app.renderAll(); app.route(); } else if (state.openId == null && $("detailView").hidden && !picking) app.renderAll();
  }, function (e) {
    if (e && e.status === 401) {
      state.expired = true;
      if (state.loaded && $("detailView").hidden) app.renderAlert();
    }
    if (first) {
      state.loaded = true; app.renderAll(); app.route();
      if (!state.expired) toast("Could not load cases. Sign in again or reload.");
    }
  });
}

/* ---------- case documents ---------- */
export function uploadFile(f, o) {
  return fetch("/api/files", { method: "POST", redirect: "manual", headers: { "x-filename": encodeURIComponent(f.name), "content-type": (o && o.type) || "application/octet-stream" }, body: f })
    .then(function (r) {
      if (isExpired(r)) throw expiredErr();
      return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || "upload failed"); e.code = j.code; throw e; } return j; });
    });
}
export function deleteFile(id) { return fetch("/api/files/" + id, { method: "DELETE", redirect: "manual" }); }

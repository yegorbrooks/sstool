// Small helpers used everywhere: DOM lookup, escaping, dates, money, toast.
import { state } from "./state.js";

export function $(id) { return document.getElementById(id); }
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
export function opts(arr, sel) {
  return arr.map(function (x) {
    return '<option value="' + esc(x) + '"' + (x === sel ? " selected" : "") + ">" + esc(x) + "</option>";
  }).join("");
}

/* ---------- dates ---------- */
export function pad2(n) { return String(n).padStart(2, "0"); }
export function dstr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
export function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
export function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function parseDate(s) {
  if (!s) return null;
  var p = s.split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
export function fmtDate(s) {
  var d = parseDate(s);
  return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}
export function fmtShort(s) {
  var d = parseDate(s);
  return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
}
export function fmtRange(a, b) {
  if (a && b && a !== b) return fmtShort(a) + " \u2013 " + fmtDate(b);
  return fmtDate(a || b);
}
export function daysUntil(s) {
  var d = parseDate(s); if (!d) return null;
  var t = parseDate(todayStr());
  return Math.round((d - t) / 86400000);
}
export function whenStr(ms) { return ms ? fmtDate(dstr(new Date(ms))) : ""; }

/* ---------- numbers and money ---------- */
export function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
// Formats an amount in the given currency (a case's own currency), or the selected one for totals.
export function money(n, cur) {
  cur = cur || state.currency;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n || 0);
  } catch (e) { return (n || 0).toFixed(2) + " " + cur; }
}
export function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

/* ---------- misc ---------- */
export function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export function docExt(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
export function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

// Sale ID comes from the internal CRM and links to the sale's edit page.
export function crmUrl(id) { return "https://crm.flyluxury.com/sales/" + encodeURIComponent(String(id).trim()) + "/edit"; }
export function crmLink(id) {
  return '<a class="crm" href="' + esc(crmUrl(id)) + '" target="_blank" rel="noopener">' + esc(id) + "</a>";
}

export function personName(email) {
  if (!email) return "";
  return String(email).split("@")[0].split(/[._-]+/).filter(Boolean).map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
export function byHtml(email) {
  return email ? ' <span class="muted by" title="' + esc(email) + '">\u00b7 ' + esc(personName(email)) + "</span>" : "";
}

var toastTimer;
export function toast(msg, ms) {
  var t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3200);
}

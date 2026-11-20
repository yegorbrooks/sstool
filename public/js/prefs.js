// Settings remembered in this browser: currency, period and sort order.
import { state } from "./state.js";
import { CURRENCIES } from "./codes.js";
import { PERIODS } from "./period.js";

var LS_PREFS = "chargebacks:prefs:v1";
// Default sort direction for each sortable column.
export var DEFAULT_DIR = { amount: "desc", disputeDate: "desc", dueDate: "asc" };

function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

export function savePrefs() {
  lsSet(LS_PREFS, { currency: state.currency, period: state.period, from: state.from, to: state.to, sortKey: state.sortKey, sortDir: state.sortDir });
}
export function loadPrefs() {
  var prefs = lsGet(LS_PREFS);
  if (!prefs) return;
  if (CURRENCIES.indexOf(prefs.currency) >= 0) state.currency = prefs.currency;
  if (PERIODS.some(function (p) { return p[0] === prefs.period; })) {
    state.period = prefs.period; state.from = prefs.from || ""; state.to = prefs.to || "";
  }
  if (DEFAULT_DIR[prefs.sortKey] && (prefs.sortDir === "asc" || prefs.sortDir === "desc")) {
    state.sortKey = prefs.sortKey; state.sortDir = prefs.sortDir;
  }
}

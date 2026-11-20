// The period picked at the top (last 30 days, this month, custom range…).
import { state } from "./state.js";
import { todayStr, parseDate, dstr, addDays, fmtShort, fmtDate } from "./util.js";

export var PERIODS = [["7d", "Last 7 days"], ["30d", "Last 30 days"], ["month", "This month"], ["1y", "Last 12 months"], ["ytd", "Year to date"], ["all", "All time"], ["custom", "Custom range"]];

// Inclusive date range for the selected period. An empty bound means open-ended.
export function periodRange() {
  var t = parseDate(todayStr()), p = state.period;
  if (p === "7d") return { from: dstr(addDays(t, -6)), to: "" };
  if (p === "30d") return { from: dstr(addDays(t, -29)), to: "" };
  if (p === "month") return { from: dstr(new Date(t.getFullYear(), t.getMonth(), 1)), to: "" };
  if (p === "1y") return { from: dstr(new Date(t.getFullYear() - 1, t.getMonth(), t.getDate() + 1)), to: "" };
  if (p === "ytd") return { from: dstr(new Date(t.getFullYear(), 0, 1)), to: "" };
  if (p === "custom") {
    var f = state.from, e = state.to;
    if (f && e && f > e) { var x = f; f = e; e = x; }
    return { from: f, to: e };
  }
  return { from: "", to: "" };
}
export function periodText() {
  var p = state.period;
  if (p === "custom") {
    var r = periodRange();
    if (r.from && r.to) return fmtShort(r.from) + " \u2013 " + fmtDate(r.to);
    if (r.from) return "since " + fmtDate(r.from);
    if (r.to) return "until " + fmtDate(r.to);
    return "all time";
  }
  for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i][0] === p) return PERIODS[i][1].toLowerCase();
  return "all time";
}
export function inPeriod(c) {
  var r = periodRange(), d = c.disputeDate || "";
  if (r.from && d < r.from) return false;
  if (r.to && d > r.to) return false;
  return true;
}

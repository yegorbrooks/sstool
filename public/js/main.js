// Startup: wires the page together and switches views from the URL hash
// (#cases, #stats, #tools, #urgent, #check, #new, #case/<id>).
import { state, app } from "./state.js";
import { $, esc, todayStr, parseDate, dstr, addDays } from "./util.js";
import { CURRENCIES } from "./codes.js";
import { PERIODS } from "./period.js";
import { savePrefs, loadPrefs } from "./prefs.js";
import { getMe, loadCases } from "./api.js";
import { renderStats } from "./stats.js";
import { renderAlert, renderTable, hideNoteTip } from "./list.js";
import { openDialog } from "./case-page.js";
import { closeViewer } from "./viewer.js";
import { renderTools } from "./tools.js";
import { exportCsv } from "./export.js";

/* ---------- top bar ---------- */
function renderControls() {
  $("period").innerHTML = PERIODS.map(function (p) {
    return '<option value="' + p[0] + '"' + (p[0] === state.period ? " selected" : "") + ">" + esc(p[1]) + "</option>";
  }).join("");
  $("customRange").hidden = state.period !== "custom";
  if ($("rangeFrom").value !== state.from) $("rangeFrom").value = state.from;
  if ($("rangeTo").value !== state.to) $("rangeTo").value = state.to;
  $("currency").innerHTML = CURRENCIES.map(function (c) {
    return '<option' + (c === state.currency ? " selected" : "") + ">" + c + "</option>";
  }).join("");
  $("newBtn").disabled = !state.canWrite;
}
function renderWho() {
  var w = $("whoami");
  if (!state.me) { w.hidden = true; return; }
  w.innerHTML = '<span title="' + esc(state.me) + '">' + esc(state.me) + '</span><a href="/cdn-cgi/access/logout">Sign out</a>';
  w.hidden = false;
}
function renderAll() {
  if (!state.loaded) return;
  renderControls(); renderStats(); renderAlert(); renderTable();
}

/* ---------- views (list <-> case page), driven by the URL hash ---------- */
var listScroll = 0;
function showView(name) {
  var detail = name === "detail", wasDetail = !$("detailView").hidden;
  if (detail && !wasDetail) listScroll = window.scrollY || 0;
  $("listView").hidden = detail;
  $("detailView").hidden = !detail;
  if (detail && !wasDetail) window.scrollTo(0, 0);
  else if (!detail && listScroll) { var y = listScroll; listScroll = 0; window.scrollTo(0, y); }
  document.title = detail ? "Case - Chargeback Tracker" : "Chargeback Tracker";
}
function showTab(t) {
  state.tab = t;
  ["cases", "stats", "tools"].forEach(function (k) {
    var on = k === t, tab = $("tab_" + k);
    $("pane_" + k).hidden = !on;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
}
function closeDetail() {
  var back = state.listHash || "";
  if (location.hash !== back) location.hash = back; else route();
}
function route() {
  var h = location.hash, target = null;
  if (h.indexOf("#case/") === 0) {
    var id = decodeURIComponent(h.slice(6));
    if (state.cases.some(function (x) { return x.id === id; })) target = id;
  } else if (h === "#new" && state.canWrite) {
    target = "new";
  }
  // Leaving a case page (Back button, browser back, another link) with unsaved changes: ask first.
  if (state.openId && state.openId !== target && state.leaveGuard) {
    if (state.leaveGuard.isDirty() && !window.confirm("You have unsaved changes on this case. Leave without saving?")) {
      location.hash = state.openId === "new" ? "#new" : "#case/" + encodeURIComponent(state.openId);
      return;
    }
    state.leaveGuard.discard();   // files uploaded but never saved to the case are removed again
    state.leaveGuard = null;
  }
  hideNoteTip();
  // Anything floating over the old page goes with it.
  if (state.openId !== target) {
    closeViewer();
    if (state.closeModal) state.closeModal();
  }
  if (target) {
    if (state.openId !== target) openDialog(target === "new" ? null : target);
    showView("detail");
    return;
  }
  if (state.openId) state.pageTok++;   // the case page is gone
  state.openId = null;
  $("detailBody").innerHTML = "";
  state.urgentOnly = h === "#urgent";
  state.checkOnly = h === "#check";
  state.listHash = h;
  var tab = h === "#stats" ? "stats" : h === "#tools" ? "tools" : "cases";
  showTab(tab);
  showView("list");
  renderAll();
  if (tab === "tools") renderTools();
}

// Lower modules reach these through `app` instead of importing this file.
app.renderAll = renderAll;
app.renderAlert = renderAlert;
app.route = route;
app.closeDetail = closeDetail;

// Closing or reloading the tab with unsaved changes: the browser shows its own warning.
window.addEventListener("beforeunload", function (e) {
  if (state.leaveGuard && state.leaveGuard.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- wire up ---------- */
loadPrefs();

function clearSpecial() { state.checkOnly = false; state.urgentOnly = false; }
$("period").onchange = function (e) {
  state.period = e.target.value;
  if (state.period === "custom" && !state.from && !state.to) {
    state.from = dstr(addDays(parseDate(todayStr()), -29)); state.to = todayStr();
  }
  savePrefs(); renderAll();
};
$("rangeFrom").onchange = function (e) { state.from = e.target.value; savePrefs(); renderAll(); };
$("rangeTo").onchange = function (e) { state.to = e.target.value; savePrefs(); renderAll(); };
$("currency").onchange = function (e) { state.currency = e.target.value; savePrefs(); renderAll(); };
$("search").oninput = function (e) {
  state.q = e.target.value; clearSpecial();
  if (location.hash === "#urgent" || location.hash === "#check") {
    history.replaceState(null, "", location.pathname + location.search + "#cases");
    state.listHash = "#cases";
  }
  renderTable();
};
$("statusFilter").onchange = function (e) { state.status = e.target.value; renderTable(); };
$("newBtn").onclick = function () { location.hash = "#new"; };
$("backBtn").onclick = closeDetail;
window.addEventListener("hashchange", route);
$("exportBtn").onclick = exportCsv;

/* ---------- start ---------- */
$("exportBtn").hidden = false;
getMe().then(function (j) { state.me = j.email || ""; renderWho(); }, function () {});
loadCases(true);
setInterval(function () { if (!document.hidden) loadCases(false); }, 30000);

// Cases tab: the alert banner, the check-status queue, the stage sections and search results.
import { state } from "./state.js";
import { $, esc, money, num, fmtDate, fmtRange, daysUntil, plural, crmLink, personName, dstr } from "./util.js";
import { STATUSES, STATUS_ORDER, STATUS_BY_STAGE, stageLabel, statusLabel, statusKind, pastCaseNos, needsStatusCheck, isUrgent } from "./model.js";
import { inPeriod, periodText } from "./period.js";
import { savePrefs, DEFAULT_DIR } from "./prefs.js";

/* ---------- alert banner ---------- */
function showSpecial(which) {
  state.q = ""; $("search").value = "";
  location.hash = which === "urgent" ? "#urgent" : "#check";
}
export function renderAlert() {
  var html = "";
  if (state.expired) {
    html += '<div class="alert hot"><span>Your sign-in expired, so this list is no longer updating.</span><button id="signInAgain">Sign in again</button></div>';
  }
  var urgent = state.cases.filter(isUrgent);
  if (urgent.length) {
    var late = urgent.filter(function (c) { return daysUntil(c.dueDate) < 0; }).length;
    var msg = late
      ? plural(late, "case is", "cases are") + " past the deadline for our decision" + (urgent.length > late ? ", and " + (urgent.length - late) + " more due within 7 days." : ".")
      : plural(urgent.length, "case needs", "cases need") + " our decision within 7 days.";
    html += '<div class="alert' + (late ? " hot" : "") + '"><span>' + esc(msg) + '</span><button id="showUrgent">Show them</button></div>';
  }
  var area = $("alertArea");
  area.innerHTML = html;
  if ($("showUrgent")) $("showUrgent").onclick = function () { showSpecial("urgent"); };
  if ($("signInAgain")) $("signInAgain").onclick = function () { location.reload(); };
}

/* ---------- filtering and sorting ---------- */
// Search box and alert links: one flat list across all stages and statuses.
function isOpenCase(c) { return c.status === "pending" || c.status === "defended"; }
function inList(c) { return isOpenCase(c) || inPeriod(c); }
function matchesFilters(c) {
  var q = state.q.trim().toLowerCase();
  if (state.checkOnly && !needsStatusCheck(c)) return false;
  if (state.urgentOnly && !isUrgent(c)) return false;
  if (q) {
    var hay = [c.caseNo, pastCaseNos(c).join(" "), c.pnr, c.saleId, c.product, c.orderRef, c.reason, c.network, c.notes].join(" ").toLowerCase();
    if (hay.indexOf(q) < 0) return false;
  }
  return true;
}
export function sortCases(list) {
  return list.slice().sort(function (a, b) {
    var k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1, r = 0;
    if (k === "amount") r = num(a.amount) - num(b.amount);
    else {
      var x = a[k] || "", y = b[k] || "";
      if (!x && !y) r = 0;
      else if (!x) return 1;        // cases without a date always go last
      else if (!y) return -1;
      else r = x < y ? -1 : x > y ? 1 : 0;
    }
    if (r) return r * dir;
    return (b.disputeDate || "").localeCompare(a.disputeDate || "") || (b.caseNo || "").localeCompare(a.caseNo || "");
  });
}
function setSort(key, sec) {
  if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  else { state.sortKey = key; state.sortDir = DEFAULT_DIR[key] || "desc"; }
  state.refocus = { key: key, sec: sec };
  savePrefs();
  renderTable();
}
function sortTh(key, label, cls, sec) {
  var on = state.sortKey === key, asc = state.sortDir === "asc";
  return '<th class="' + (cls || "") + '" aria-sort="' + (on ? (asc ? "ascending" : "descending") : "none") + '">' +
    '<button type="button" class="sortbtn' + (on ? " on" : "") + '" data-sort="' + key + '" data-sec="' + sec + '">' + esc(label) +
    '<span class="arr" aria-hidden="true">' + (on ? (asc ? "\u25B2" : "\u25BC") : "\u2195") + "</span></button></th>";
}

// Cases tab, top to bottom.
var SECTIONS = [["first", "First chargeback"], ["prearb", "Pre-arbitration"], ["inquiry", "Inquiries (RFI)"], ["arb", "Arbitration"]];

/* ---------- note icon in the case lists ---------- */
// Who last edited the notes and when: the latest "Notes edited." history entry,
// or whoever added the case if the note was written when the case was created.
function noteMeta(c) {
  var h = (c.history || []).filter(function (x) { return x.text === "Notes edited."; }).pop();
  if (h) return { by: h.by, at: h.at };
  return { by: c.createdBy, at: c.createdAt ? dstr(new Date(c.createdAt)) : "" };
}
function noteIcon(c) {
  var n = String(c.notes || "").trim();
  if (!n) return "";
  return '<span class="noteicon" tabindex="0" role="img" aria-label="' + esc("Note: " + n) + '" data-note="' + esc(c.id) + '">' +
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<path d="M3 2.5h7l3 3v8H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<path d="M10 2.5v3h3M5.5 8.5h5M5.5 11h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    "</svg></span>";
}
// The note pops up in a box attached to the page itself, so the table's scrolling edges can't cut it off.
function showNoteTip(el) {
  var c = state.cases.filter(function (x) { return x.id === el.getAttribute("data-note"); })[0];
  if (!c || !String(c.notes || "").trim()) return;
  var t = $("noteTip");
  if (!t) {
    t = document.createElement("div");
    t.id = "noteTip"; t.className = "notetip"; t.setAttribute("role", "tooltip");
    document.body.appendChild(t);
  }
  var n = String(c.notes).trim();
  if (n.length > 600) n = n.slice(0, 600).trimEnd() + "\u2026";
  var m = noteMeta(c), who = [personName(m.by), fmtDate(m.at)].filter(Boolean).join(", ");
  t.innerHTML = '<div class="nt-text"></div>' + (who ? '<div class="nt-meta"></div>' : "");
  t.querySelector(".nt-text").textContent = n;
  if (who) t.querySelector(".nt-meta").textContent = who;
  t.hidden = false;
  // Above the icon, right edges lined up; below it if there is no room above.
  var r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight, gap = 8;
  var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
  var top = r.top - h - gap;
  if (top < 8) top = Math.min(r.bottom + gap, window.innerHeight - h - 8);
  t.style.left = left + "px"; t.style.top = top + "px";
}
export function hideNoteTip() { var t = $("noteTip"); if (t) t.hidden = true; }
window.addEventListener("scroll", hideNoteTip, true);

/* ---------- tables ---------- */
function caseRow(c, showStage, inQueue) {
  var due = "";
  if (c.dueDate) {
    var cls = "", tag = "";
    if (c.status === "pending") {
      var d = daysUntil(c.dueDate);
      cls = d < 0 ? "due-late" : d <= 7 ? "due-soon" : "";
      tag = d < 0 ? " (overdue)" : d === 0 ? " (today)" : d <= 7 ? " (" + d + "d)" : "";
    }
    due = '<span class="' + cls + '">' + esc(fmtDate(c.dueDate) + tag) + "</span>";
  }
  return '<tr tabindex="0" data-id="' + esc(c.id) + '">' +
    '<td class="pnr">' + esc(c.pnr || "\u2014") + "</td>" +
    "<td>" + (c.saleId ? crmLink(c.saleId) : "\u2014") + "</td>" +
    "<td>" + esc(c.source || "\u2014") + "</td>" +
    '<td class="num">' + esc(money(num(c.amount), c.currency)) + "</td>" +
    "<td>" + esc(fmtDate(c.disputeDate)) + "</td>" +
    "<td>" + due + "</td>" +
    "<td>" + esc(fmtRange(c.travelFrom, c.travelTo)) + "</td>" +
    (showStage ? "<td>" + esc(stageLabel(c.stage, c.network)) + "</td>" : "") +
    '<td><span class="pill ' + statusKind(c.status) + '">' + esc(statusLabel(c.status)) + "</span>" +
      (inQueue ? ' <span class="muted">' + esc(stageLabel(c.stage, c.network)) + "</span>"
        : needsStatusCheck(c) ? ' <span class="pill act">Check status</span>' : "") + noteIcon(c) + "</td></tr>";
}
function caseTable(list, sec, showStage) {
  return '<div class="tablewrap"><table><thead><tr><th>PNR</th><th>Sale ID</th><th>Source</th>' +
    sortTh("amount", "Amount", "num", sec) + sortTh("disputeDate", "Disputed date", "", sec) + sortTh("dueDate", "Due date", "", sec) +
    "<th>Travel date</th>" + (showStage ? "<th>Dispute cycle</th>" : "") + "<th>Status</th></tr></thead><tbody>" +
    list.map(function (c) { return caseRow(c, showStage, sec === "check"); }).join("") + "</tbody></table></div>";
}
function checkQueue() {
  var list = sortCases(state.cases.filter(needsStatusCheck));
  if (!list.length) return "";
  return '<section class="casesec checkq" aria-label="Check status"><div class="sechead"><h3>Check status <span class="muted">(' +
    list.length + ")</span></h3></div>" + caseTable(list, "check", false) + "</section>";
}

export function renderTable() {
  hideNoteTip();
  var area = $("tableArea");
  var special = state.urgentOnly || state.checkOnly, searching = !!state.q.trim();
  var sf = $("statusFilter");
  sf.hidden = special || searching || !state.cases.length;
  if (!state.cases.length) {
    $("listTitle").textContent = "Cases";
    area.innerHTML = '<div class="empty"><p>No cases yet.</p>' +
      (state.canWrite ? '<button class="btn primary" id="emptyAdd">Add case</button>' : "") + "</div>";
    var eb = $("emptyAdd"); if (eb) eb.onclick = function () { location.hash = "#new"; };
    return;
  }
  if (special || searching) {
    // Search and the alert links cover every case, whatever period is selected.
    var list = sortCases(state.cases.filter(matchesFilters));
    var title = state.urgentOnly ? "Cases needing a decision" : state.checkOnly ? "Cases to check" : "Search results";
    $("listTitle").innerHTML = '<button type="button" class="btn backall" id="clearSpecial">&larr; All cases</button> ' +
      esc(title + " (" + list.length + ")");
    $("clearSpecial").onclick = function () {
      state.q = ""; $("search").value = "";
      if (state.urgentOnly || state.checkOnly) location.hash = "#cases"; else renderTable();
    };
    area.innerHTML = list.length ? caseTable(list, "all", true) : '<div class="empty"><p>No cases match.</p></div>';
  } else {
    var sel = state.status === "all" || STATUSES[state.status] ? state.status : "pending";
    var all = sel === "all";
    $("listTitle").textContent = sel === "pending" || sel === "defended" ? "Cases" : "Cases, " + periodText();
    var inPer = state.cases.filter(inList);
    var counts = {};
    STATUS_ORDER.forEach(function (k) { counts[k] = 0; });
    inPer.forEach(function (c) { if (c.status in counts) counts[c.status]++; });
    sf.innerHTML = '<option value="all"' + (all ? " selected" : "") + ">" + esc("All statuses (" + inPer.length + ")") + "</option>" +
      STATUS_ORDER.map(function (k) {
        return '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + esc(STATUSES[k].label + " (" + counts[k] + ")") + "</option>";
      }).join("");
    area.innerHTML = checkQueue() + SECTIONS.map(function (s) {
      var key = s[0];
      var rows = sortCases(inPer.filter(function (c) { return c.stage === key && (all || c.status === sel); }));
      var lbl = all ? "" : STATUSES[sel].label.toLowerCase();
      var empty = all ? "No cases." : STATUS_BY_STAGE[key].indexOf(sel) < 0 ? s[1] + " has no " + lbl + " status." : "No " + lbl + " cases.";
      return '<section class="casesec" aria-label="' + esc(s[1]) + '"><div class="sechead"><h3>' + esc(s[1]) + "</h3></div>" +
        (rows.length ? caseTable(rows, key, false) : '<p class="muted secempty">' + esc(empty) + "</p>") +
        "</section>";
    }).join("");
  }
  Array.prototype.forEach.call(area.querySelectorAll("th button[data-sort]"), function (btn) {
    btn.onclick = function () { setSort(btn.getAttribute("data-sort"), btn.getAttribute("data-sec")); };
  });
  if (state.refocus) {
    var rb = area.querySelector('th button[data-sort="' + state.refocus.key + '"][data-sec="' + state.refocus.sec + '"]');
    if (rb) rb.focus();
    state.refocus = null;
  }
  Array.prototype.forEach.call(area.querySelectorAll(".noteicon"), function (ic) {
    ic.onmouseenter = ic.onfocus = function () { showNoteTip(ic); };
    ic.onmouseleave = ic.onblur = hideNoteTip;
  });
  Array.prototype.forEach.call(area.querySelectorAll("a.crm"), function (a) {
    a.onclick = function (e) { e.stopPropagation(); };
  });
  Array.prototype.forEach.call(area.querySelectorAll("tbody tr"), function (tr) {
    var open = function () { location.hash = "#case/" + encodeURIComponent(tr.getAttribute("data-id")); };
    tr.onclick = open;
    tr.onkeydown = function (e) { if (e.target !== tr) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  });
}

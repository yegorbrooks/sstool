// Case page: the add/edit form, documents, stage and status, "Move to next stage" dialog.
import { state, app } from "./state.js";
import { $, esc, opts, num, money, toast, uid, todayStr, parseDate, dstr, addDays, fmtDate, fmtSize, whenStr, personName, byHtml, crmLink } from "./util.js";
import { NETWORKS, SOURCES, DEFAULT_VISA_REASON, defaultReason, reasonOptions, productOpts, currencyOpts } from "./codes.js";
import { STATUSES, STATUS_BY_STAGE, stagesFor, laterStages, stageLabel, statusLabel, norm, needsStatusCheck, followUpDate, followUpDays, checkFrom } from "./model.js";
import { inPeriod } from "./period.js";
import { savePrefs } from "./prefs.js";
import { saveCase, removeCase, loadCases, uploadFile, deleteFile } from "./api.js";
import { openViewer, downloadDoc } from "./viewer.js";
import { tool, tplFor } from "./tools.js";

var DOC_ERR = {
  too_large: "is over the 50 MB limit",
  invalid_request: "is empty",
  expired: "could not be uploaded because your sign-in expired. Open the app in a new tab to sign in, then upload it again"
};

// Fields that must be filled in before a new case can be created.
var REQUIRED_FIELDS = [
  ["f_pnr", "PNR"], ["f_saleId", "Sale ID"], ["f_source", "Source"], ["f_orderRef", "Transaction ref"], ["f_transactionDate", "Transaction date"],
  ["f_caseNo", "Case number"], ["f_disputeDate", "Date disputed"], ["f_dueDate", "Respond by"],
  ["f_network", "Card network"], ["f_reason", "Reason"], ["f_amount", "Disputed amount"]
];
// Fields whose edits are written to the case history.
var TRACKED = [
  ["caseNo", "Case number"], ["pnr", "PNR"], ["saleId", "Sale ID"], ["product", "Product"], ["source", "Source"],
  ["travelFrom", "Travel start", "date"], ["travelTo", "Travel end", "date"], ["orderRef", "Transaction ref"],
  ["transactionDate", "Transaction date", "date"], ["disputeDate", "Date disputed", "date"], ["network", "Card network"],
  ["reason", "Reason"], ["amount", "Disputed amount", "money"], ["currency", "Currency"], ["fee", "Dispute fees", "money"],
  ["feesCharged", "Fees charged", "bool"], ["notes", "Notes", "text"]
];

/* ---------- small pieces of the page ---------- */
function stageOpts(sel, network) {
  var list = stagesFor(network).slice();
  if (list.indexOf(sel) < 0) list.unshift(sel);   // keep a stage saved earlier
  return list.map(function (k) {
    return '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + esc(stageLabel(k, network)) + "</option>";
  }).join("");
}
function statusOpts(stage, sel) {
  var list = STATUS_BY_STAGE[stage];
  if (list.indexOf(sel) < 0) sel = list[0];
  return list.map(function (k) {
    return '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + esc(STATUSES[k].label) + "</option>";
  }).join("");
}
function historyHtml(c) {
  var hist = (c.history || []).slice().reverse();
  if (!hist.length) return "";
  return '<div class="flow"><h4>History</h4><ol class="timeline">' + hist.map(function (h) {
    return '<li><span class="when">' + esc(fmtDate(h.at)) + "</span><span>" + esc(h.text) + byHtml(h.by) + "</span></li>";
  }).join("") + "</ol></div>";
}
function stageDatesHtml(c) {
  var log = c.stageLog || [];
  if (!log.length) return "";
  return '<div class="flow"><h4>Stage dates</h4><ol class="timeline">' + log.map(function (s) {
    var bits = [];
    if (s.caseNo) bits.push("Case " + s.caseNo);
    if (s.amount) bits.push(money(num(s.amount), c.currency));
    bits.push("Received " + (fmtDate(s.received) || "\u2014") + (s.due ? ", respond by " + fmtDate(s.due) : ""));
    return '<li><span class="when">' + esc(stageLabel(s.stage, c.network)) + "</span><span>" + esc(bits.join(" \u00b7 ")) + "</span></li>";
  }).join("") + "</ol></div>";
}
function showVal(v, kind, cur) {
  if (kind === "bool") return v ? "yes" : "no";
  if (v === "" || v == null) return "none";
  if (kind === "date") return fmtDate(v);
  if (kind === "money") return money(num(v), cur);
  return String(v);
}
function editLog(a, b) {
  var out = [];
  TRACKED.forEach(function (f) {
    var k = f[0], x = a[k], y = b[k];
    if (f[2] === "money") { if (num(x) === num(y)) return; }
    else if (f[2] === "bool") { if (!!x === !!y) return; }
    else if (String(x == null ? "" : x) === String(y == null ? "" : y)) return;
    out.push(f[2] === "text" ? f[1] + " edited" : f[1] + " changed from " + showVal(x, f[2], a.currency) + " to " + showVal(y, f[2], b.currency));
  });
  var had = {}, has = {};
  (a.docs || []).forEach(function (d) { had[d.id] = 1; });
  (b.docs || []).forEach(function (d) { has[d.id] = 1; if (!had[d.id]) out.push("Document added: " + d.name); });
  (a.docs || []).forEach(function (d) { if (!has[d.id]) out.push("Document removed: " + d.name); });
  return out;
}
function whoLine(c) {
  var parts = [];
  if (c.createdBy) parts.push("Added by " + esc(personName(c.createdBy)) + (c.createdAt ? " on " + esc(whenStr(c.createdAt)) : ""));
  if (c.updatedBy) parts.push("Last changed by " + esc(personName(c.updatedBy)) + (c.updatedAt ? " on " + esc(whenStr(c.updatedAt)) : ""));
  return parts.length ? '<span class="muted">' + parts.join(" \u00b7 ") + "</span>" : "";
}
// A snapshot of every field on the case page, used to tell whether anything was changed.
function formSnap() {
  return Array.prototype.map.call($("detailBody").querySelectorAll("input, select, textarea"), function (el) {
    if (el.type === "file") return "";
    return el.id + "=" + (el.type === "checkbox" ? el.checked : el.value);
  }).join("\n");
}

/* ---------- the case page ---------- */
export function openDialog(id) {
  var myTok = ++state.pageTok;
  function alive() { return myTok === state.pageTok; }
  var c = id ? state.cases.filter(function (x) { return x.id === id; })[0] : null;
  var isNew = !c;
  c = c || {orderRef: "", network: "Visa", reason: DEFAULT_VISA_REASON, pnr: "", product: "Ticket Cost", travelFrom: "", travelTo: "", amount: "", currency: state.currency, fee: "", feesCharged: false, disputeDate: todayStr(), dueDate: "", stage: "first", status: "pending", notes: "", history: [], transactionDate: "", docs: [] };
  // Dates of the stage the case is in now.
  var cur = isNew ? { received: c.disputeDate, due: "" } : c.stageLog[c.stageLog.length - 1];
  var ro = !state.canWrite;
  var dis = ro ? " disabled" : "";
  $("detailBody").innerHTML =
    '<div class="case-head"><h3 id="dlgTitle">' + (isNew ? "Add case" : "Case " + esc(c.caseNo)) + "</h3>" +
      (!isNew && (c.pnr || c.saleId) ? '<span class="muted">' + [c.pnr ? "PNR " + esc(c.pnr) : "", c.saleId ? "Sale " + crmLink(c.saleId) : ""].filter(Boolean).join(" \u00b7 ") + "</span>" : "") +
      (isNew ? "" : whoLine(c)) + "</div>" +
    '<div class="case-layout">' +
    '<div class="dlg">' +
      '<section class="sec"><h4>Booking</h4><div class="grid g3">' +
        '<label class="f">PNR<input id="f_pnr" class="pnr-in" maxlength="12" autocapitalize="characters" autocomplete="off" value="' + esc(c.pnr) + '"' + dis + "></label>" +
        '<label class="f">Sale ID<input id="f_saleId" inputmode="numeric" autocomplete="off" placeholder="12345" value="' + esc(c.saleId) + '"' + dis + '><span class="hint" id="saleHint"></span></label>' +
        '<label class="f">Product<select id="f_product"' + dis + '><option value="">Not set</option>' + productOpts(c.product) + "</select></label>" +
        '<label class="f">Source<select id="f_source"' + dis + '><option value="">Select source</option>' + opts(SOURCES, c.source) + "</select></label>" +
        '<label class="f">Travel start<input id="f_travelFrom" type="date" value="' + esc(c.travelFrom) + '"' + dis + "></label>" +
        '<label class="f">Travel end<input id="f_travelTo" type="date" value="' + esc(c.travelTo) + '"' + dis + "></label>" +
        '<label class="f">Order or transaction ref<input id="f_orderRef" value="' + esc(c.orderRef) + '"' + dis + '><span class="hint" id="refHint"></span></label>' +
        '<label class="f">Transaction date<input id="f_transactionDate" type="date" value="' + esc(c.transactionDate) + '"' + dis + '><span class="hint" id="txHint"></span></label>' +
      "</div></section>" +
      '<section class="sec"><h4>Dispute</h4><div class="grid g3">' +
        '<label class="f">Case number<input id="f_caseNo" value="' + esc(c.caseNo) + '"' + dis + "></label>" +
        '<label class="f">Date disputed<input id="f_disputeDate" type="date" value="' + esc(c.disputeDate) + '"' + dis + "></label>" +
        '<label class="f">Card network<select id="f_network"' + dis + ">" + opts(NETWORKS, c.network) + "</select></label>" +
        '<label class="f">Reason<select id="f_reason"' + dis + ">" + reasonOptions(c.network, c.reason) + "</select></label>" +
        '<label class="f">Disputed amount<input id="f_amount" type="number" step="0.01" min="0" inputmode="decimal" value="' + esc(c.amount) + '"' + dis + "></label>" +
        '<label class="f">Currency<select id="f_currency"' + dis + ">" + currencyOpts(c.currency) + "</select></label>" +
        '<label class="f">Dispute fees<input id="f_fee" type="number" step="0.01" min="0" inputmode="decimal" value="' + esc(c.fee) + '"' + dis + "></label>" +
        '<label class="chk chk-end"><input id="f_feesCharged" type="checkbox"' + (c.feesCharged ? " checked" : "") + dis + "> Dispute fees were charged to us</label>" +
      "</div></section>" +
      '<section class="sec" id="docSec"><h4>Documents <span class="muted" id="docCount"></span></h4>' +
        (ro ? "" : '<div class="docadd">' +
          '<input type="file" id="f_docFile" multiple hidden>' +
          '<button class="btn" type="button" id="docBtn">Upload files</button></div>') +
        '<ul class="doclist" id="docList"></ul></section>' +
      '<section class="sec"><h4>Notes</h4><label class="f"><span class="sr">Notes</span><textarea id="f_notes"' + dis + ">" + esc(c.notes) + "</textarea></label></section>" +
      '<div class="err" id="dlgErr" role="alert"></div>' +
      '<div class="dlg-actions">' +
        (!isNew && !ro ? '<button class="btn danger" id="delBtn">Delete case</button>' : "") +
        (!isNew ? '<button class="btn" type="button" id="emailBtn">Email\u2026</button>' : "") +
        '<span class="spacer"></span>' +
        '<button class="btn" id="cancelBtn">' + (ro ? "Close" : "Cancel") + "</button>" +
        (!ro ? '<button class="btn primary" id="saveBtn">' + (isNew ? "Add case" : "Save changes") + "</button>" : "") +
      "</div>" +
    "</div>" +
    '<aside class="side">' +
      '<div class="dlg"><section class="sec nobd"><h4>Stage and status</h4><div class="grid">' +
        '<label class="f full">Stage<select id="f_stage"' + (isNew ? dis : " disabled") + ">" + stageOpts(c.stage, c.network) + "</select></label>" +
        '<label class="f full">Status<select id="f_status"' + dis + ">" + statusOpts(c.stage, c.status) + "</select></label>" +
        (!isNew && !ro && laterStages(c).length ? '<button class="btn full" type="button" id="moveBtn">Move to ' +
          esc(stageLabel(laterStages(c)[0], c.network)) + "\u2026</button>" : "") +
        '<label class="f full"><span id="recvLabel"></span><input id="f_stageReceived" type="date" value="' + esc(cur.received) + '"' + dis + "></label>" +
        '<label class="f full">Respond by<input id="f_dueDate" type="date" value="' + esc(c.dueDate) + '"' + dis + "></label>" +
        '<label class="f full">Date of status update<input id="f_stepDate" type="date" value="' + todayStr() + '"' + dis + "></label>" +
        (!isNew && needsStatusCheck(c) ? '<div class="explain full" id="checkLive"><strong>Time to check this case.</strong> ' +
          esc("Check was due " + fmtDate(followUpDate(c)) + " (" + followUpDays(c) + " days after " +
            (c.checkedAt && c.checkedAt > checkFrom(c) ? "the last check" : c.dueDate ? "the respond-by date" : "our reply") + ").") +
          (ro ? "" : '<br><button class="btn" id="checkedBtn" type="button" style="margin-top:8px">Checked, still waiting</button>') + "</div>" : "") +
      "</div></section></div>" +
      (isNew ? "" : '<div class="dlg">' + stageDatesHtml(c) + "</div>") +
      (isNew || !(c.history || []).length ? "" : '<div class="dlg">' + historyHtml(c) + "</div>") +
    "</aside></div>";

  function close() { app.closeDetail(); }
  function fail(m) { $("dlgErr").textContent = m; }

  // Save and Move wait while files are uploading or a save is under way.
  var uploading = 0, saving = false;
  function setBusy() {
    if (!alive()) return;
    var busy = uploading > 0 || saving;
    if ($("saveBtn")) $("saveBtn").disabled = busy;
    if ($("moveBtn")) $("moveBtn").disabled = busy;
    if ($("docBtn")) $("docBtn").textContent = uploading ? "Uploading " + uploading + "\u2026" : "Upload files";
  }

  /* ---------- form behaviour ---------- */
  function autoFees() {
    if ($("f_stage").value === "arb" && $("f_status").value === "lost") $("f_feesCharged").checked = true;
  }
  function recvLabel() {
    $("recvLabel").textContent = stageLabel($("f_stage").value, $("f_network").value) + " received on";
  }
  // Only a new case can pick its stage here; existing cases change stage with "Move to …".
  $("f_stage").onchange = function () {
    $("f_status").innerHTML = statusOpts($("f_stage").value, $("f_status").value);
    recvLabel(); autoFees();
  };
  $("f_status").onchange = autoFees;
  // Amex gives 20 days from the notice; suggest that deadline unless the user typed their own.
  var lastAuto = (c.network === "Amex" && cur.received && c.dueDate === dstr(addDays(parseDate(cur.received), 20))) ? c.dueDate : "";
  function suggestDue() {
    if ($("f_network").value !== "Amex") return;
    var rd = $("f_stageReceived").value; if (!rd) return;
    var due = $("f_dueDate").value;
    if (due === "" || due === lastAuto) { lastAuto = dstr(addDays(parseDate(rd), 20)); $("f_dueDate").value = lastAuto; }
  }
  // On a new case the stage received date follows "Date disputed" until it is edited.
  var recvSynced = isNew;
  $("f_stageReceived").onchange = function () { recvSynced = false; suggestDue(); };
  // Warning only: dispute filed outside Amex's usual 120-day window.
  function refreshTx() {
    var el = $("txHint"), tx = $("f_transactionDate").value, dd = $("f_disputeDate").value;
    el.className = "hint warn"; el.textContent = "";
    if ($("f_network").value !== "Amex" || !tx || !dd) return;
    var days = Math.round((parseDate(dd) - parseDate(tx)) / 86400000);
    if (days < 0) el.textContent = "Dispute date is before the transaction date.";
    else if (days > 120) el.textContent = "Filed " + days + " days after the transaction (Amex limit is usually 120).";
  }
  // Warning only: Amex normally allows at most 2 disputes per charge.
  function refreshRef() {
    var el = $("refHint"), ref = $("f_orderRef").value.trim().toLowerCase();
    el.className = "hint warn"; el.textContent = "";
    if ($("f_network").value !== "Amex" || !ref) return;
    var others = state.cases.filter(function (x) { return x.id !== c.id && x.network === "Amex" && (x.orderRef || "").trim().toLowerCase() === ref; }).length;
    if (others >= 2) el.textContent = others + " other Amex cases use this reference (limit is usually 2 per charge).";
  }
  function refreshAmexBits() { refreshTx(); refreshRef(); }
  $("f_transactionDate").onchange = refreshTx;
  function refreshSale() {
    var sid = $("f_saleId").value.trim();
    $("saleHint").innerHTML = sid ? crmLink(sid).replace(">" + esc(sid) + "<", ">Open in CRM<") : "";
  }
  $("f_saleId").oninput = refreshSale;
  refreshSale();
  $("f_orderRef").oninput = refreshRef;
  $("f_network").onchange = function () {
    var net = $("f_network").value;
    // A reason code from another network does not apply here: fall back to this network's default.
    var rv = $("f_reason").value;
    if (reasonOptions(net, "").indexOf('value="' + esc(rv) + '"') < 0) rv = defaultReason(net);
    $("f_reason").innerHTML = reasonOptions(net, rv);
    // An existing case keeps its stage whatever the network; only a new case falls back to the first stage.
    var prev = $("f_stage").value, st = prev;
    if (isNew && stagesFor(net).indexOf(st) < 0) st = "first";
    $("f_stage").innerHTML = stageOpts(st, net);
    if (st !== prev) $("f_stage").onchange();
    else $("f_status").innerHTML = statusOpts(st, $("f_status").value);
    recvLabel(); suggestDue(); refreshAmexBits(); autoFees();
  };
  $("f_disputeDate").onchange = function () {
    if (recvSynced) $("f_stageReceived").value = $("f_disputeDate").value;
    suggestDue(); refreshTx();
  };
  recvLabel();
  refreshAmexBits();

  /* ---------- documents ---------- */
  var docs = (c.docs || []).slice(), addedIds = [], removedIds = [];
  function dropAsset(id) { deleteFile(id).catch(function () {}); }
  function renderDocs() {
    if (!alive()) return;
    $("docCount").textContent = docs.length ? "(" + docs.length + ")" : "";
    $("docList").innerHTML = docs.length ? docs.map(function (d, i) {
      return '<li><div class="dname"><button type="button" class="linkbtn" data-view="' + i + '" title="View">' + esc(d.name) + "</button>" +
        '<span class="muted">' + esc(fmtSize(d.size) + " \u00b7 " + fmtDate(d.at) + (d.by ? " \u00b7 " + personName(d.by) : "")) + "</span></div>" +
        '<div class="dact"><button class="btn" type="button" data-view="' + i + '">View</button><button class="btn" type="button" data-dl="' + i + '">Download</button>' +
        (ro ? "" : '<button class="btn danger" type="button" data-rm="' + i + '">Remove</button>') + "</div></li>";
    }).join("") : '<li class="muted">No documents yet.</li>';
    Array.prototype.forEach.call($("docList").querySelectorAll("[data-rm]"), function (b) {
      b.onclick = function () {
        var d = docs.splice(+b.getAttribute("data-rm"), 1)[0];
        var k = addedIds.indexOf(d.id);
        // An upload from this visit that was never saved is deleted right away.
        // A document already saved on the case only leaves the list; its file stays stored.
        if (k >= 0) { addedIds.splice(k, 1); dropAsset(d.id); } else removedIds.push(d.id);
        renderDocs();
      };
    });
    Array.prototype.forEach.call($("docList").querySelectorAll("[data-view]"), function (b) {
      b.onclick = function () { openViewer(docs[+b.getAttribute("data-view")]); };
    });
    Array.prototype.forEach.call($("docList").querySelectorAll("[data-dl]"), function (b) {
      b.onclick = function () { downloadDoc(docs[+b.getAttribute("data-dl")]); };
    });
  }
  if ($("docBtn")) {
    $("docBtn").onclick = function () { $("f_docFile").click(); };
    $("f_docFile").onchange = function () {
      var files = Array.prototype.slice.call(this.files); this.value = "";
      if (!files.length) return;
      uploading += files.length; setBusy();
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          if (!alive()) return;   // the case page was closed: skip the rest
          return uploadFile(f, { type: f.type || "application/octet-stream" }).then(function (r) {
            // Finished after the page was closed: the file belongs to no case, so remove it again.
            if (!alive()) { dropAsset(r.id); return; }
            addedIds.push(r.id);
            docs.push({ id: r.id, name: f.name, size: r.sizeBytes, type: r.contentType, at: todayStr(), by: state.me || "" });
            renderDocs();
          }, function (e) { toast(f.name + " " + (DOC_ERR[e && e.code] || "could not be uploaded") + ".", e && e.code === "expired" ? 8000 : 0); });
        }).then(function () { uploading--; setBusy(); });
      });
    };
  }
  renderDocs();

  /* ---------- turning the form into a case ---------- */
  function collect() {
    if (isNew) {
      var missing = REQUIRED_FIELDS.filter(function (r) {
        var el = $(r[0]), v = String(el.value || "").trim();
        var bad = !v || (r[0] === "f_amount" && num(v) <= 0);
        el.classList.toggle("invalid", bad);
        return bad;
      });
      if (missing.length) {
        fail("Required before adding the case: " + missing.map(function (r) { return r[1]; }).join(", ") + ".");
        $(missing[0][0]).focus();
        return null;
      }
    }
    if ($("f_amount").value === "" || num($("f_amount").value) <= 0) { fail("Enter the disputed amount."); return null; }
    if (!$("f_disputeDate").value) { fail("Enter the date the dispute was raised."); return null; }
    if ($("f_travelFrom").value && $("f_travelTo").value && $("f_travelTo").value < $("f_travelFrom").value) { fail("Travel end cannot be before travel start."); return null; }
    // An existing case never changes stage here (that is what "Move to …" is for).
    var stage = isNew ? $("f_stage").value : c.stage, status = $("f_status").value;
    var stepDate = $("f_stepDate").value || todayStr();
    var received = $("f_stageReceived").value, due = $("f_dueDate").value;
    var net = $("f_network").value;
    var caseNo = $("f_caseNo").value.trim() || c.caseNo;
    var amount = num($("f_amount").value);
    var sLabel = stageLabel(stage, net);
    if (!received) { fail("Enter the date the " + sLabel + " notice was received."); $("f_stageReceived").focus(); return null; }
    if (due && due < received) { fail("Respond by cannot be before the received date."); $("f_dueDate").focus(); return null; }
    var history = (c.history || []).slice();
    var stageLog = (c.stageLog || []).map(function (s) { return { stage: s.stage, received: s.received, due: s.due, caseNo: s.caseNo || "", amount: s.amount }; });
    var label = sLabel + ": " + statusLabel(status);
    if (isNew) {
      var start = stage === "inquiry" ? "inquiry" : "first";
      history.push({ at: $("f_disputeDate").value, stage: start, status: "pending",
        text: start === "inquiry" ? "Inquiry received. Nothing debited." : net === "Amex" ? "Dispute received." : "Dispute received. Amount debited." });
      if (stage !== start) history.push({ at: received, stage: stage, status: STATUS_BY_STAGE[stage][0], text: sLabel + " received" + (due ? ", respond by " + fmtDate(due) : "") + "." });
      if (status !== STATUS_BY_STAGE[stage][0]) history.push({ at: stepDate, stage: stage, status: status, text: "Case entered as " + label + "." });
      stageLog = [{ stage: stage, received: received, due: due, caseNo: caseNo, amount: amount }];
    } else {
      if (status !== c.status) history.push({ at: stepDate, stage: stage, status: status, text: label + "." });
      // Dates edited: keep the old values in the history.
      var last = stageLog[stageLog.length - 1];
      if (received !== last.received) history.push({ at: todayStr(), stage: stage, text: sLabel + " received date changed from " + (fmtDate(last.received) || "none") + " to " + fmtDate(received) + "." });
      if (due !== (c.dueDate || "")) history.push({ at: todayStr(), stage: stage, text: "Respond by changed from " + (fmtDate(c.dueDate) || "none") + " to " + (fmtDate(due) || "none") + "." });
      last.received = received; last.due = due;
      last.caseNo = caseNo; last.amount = amount;
    }
    var rec = {
      id: c.id || uid(),
      _v: c._v,
      caseNo: caseNo,
      customer: c.customer || "",   // kept only so older cases don't lose it
      pnr: $("f_pnr").value.trim().toUpperCase(),
      saleId: $("f_saleId").value.trim(),
      product: $("f_product").value,
      source: $("f_source").value,
      travelFrom: $("f_travelFrom").value,
      travelTo: $("f_travelTo").value,
      orderRef: $("f_orderRef").value.trim(),
      transactionDate: $("f_transactionDate").value,
      network: $("f_network").value,
      reason: $("f_reason").value,
      amount: amount,
      currency: $("f_currency").value,
      fee: num($("f_fee").value),
      feesCharged: $("f_feesCharged").checked || (stage === "arb" && status === "lost"),
      disputeDate: $("f_disputeDate").value,
      dueDate: due,
      stage: stage,
      status: status,
      notes: $("f_notes").value.trim(),
      history: history,
      stageLog: stageLog,
      docs: docs.slice(),
      createdAt: c.createdAt || Date.now(),
      checkedAt: c.checkedAt || ""
    };
    // Existing case: log every field that was edited, plus documents added or removed.
    if (!isNew) editLog(c, rec).forEach(function (t) { rec.history.push({ at: todayStr(), stage: stage, text: t + "." }); });
    return rec;
  }

  // Someone else saved this case after we opened it: our save was refused, nothing was overwritten.
  function showConflict() {
    $("dlgErr").innerHTML = esc("Someone else saved this case after you opened it, so your changes were not saved. " +
      "Copy anything you need from the form, then load their version" + (addedIds.length ? " (files you uploaded here will need to be uploaded again)" : "") + ". ") +
      '<button type="button" class="linkbtn" id="reloadCase">Load their version</button>';
    $("reloadCase").onclick = function () {
      if (state.leaveGuard) state.leaveGuard.discard();
      state.leaveGuard = null;
      loadCases(false).then(function () { state.openId = null; app.route(); });
    };
  }

  /* ---------- "Move to next stage" dialog ---------- */
  // The next stage's notice arrived: record its case number, dates and amount, and move the case on.
  function openMove() {
    if (state.leaveGuard && state.leaveGuard.isDirty()) { fail("Save or cancel your changes before moving the case to the next stage."); return; }
    var stages = laterStages(c);
    var m = document.createElement("div");
    m.className = "modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "moveTitle");
    m.innerHTML = '<div class="dlg modalbox"><h3 id="moveTitle">Move case ' + esc(c.caseNo) + " to the next stage</h3>" +
      '<p class="muted">The ' + esc(stageLabel(c.stage, c.network)) + " case number, dates and amount stay in Stage dates.</p>" +
      '<div class="grid">' +
        '<label class="f full">Stage<select id="e_stage">' + stages.map(function (k) {
          return '<option value="' + k + '">' + esc(stageLabel(k, c.network)) + "</option>";
        }).join("") + "</select></label>" +
        '<label class="f full">Case number for this stage<input id="e_caseNo" autocomplete="off">' +
          '<span class="hint">If the bank kept the same number, enter ' + esc(c.caseNo) + " again.</span></label>" +
        '<label class="f"><span id="e_recvLabel"></span><input id="e_received" type="date"></label>' +
        '<label class="f">Respond by<input id="e_due" type="date"></label>' +
        '<label class="f">Disputed amount (' + esc(c.currency) + ')<input id="e_amount" type="number" step="0.01" min="0" inputmode="decimal" value="' + esc(c.amount) + '"></label>' +
      '</div><div class="err" id="e_err" role="alert"></div>' +
      '<div class="dlg-actions"><span class="spacer"></span><button class="btn" type="button" id="e_cancel">Cancel</button>' +
        '<button class="btn primary" type="button" id="e_ok"></button></div></div>';
    document.body.appendChild(m);

    function closeMove() {
      m.remove(); document.removeEventListener("keydown", key);
      if (state.closeModal === closeMove) state.closeModal = null;
    }
    function key(e) { if (e.key === "Escape") closeMove(); }
    document.addEventListener("keydown", key);
    state.closeModal = closeMove;   // leaving the page (browser Back) closes the dialog too
    function labels() {
      var l = stageLabel($("e_stage").value, c.network);
      $("e_recvLabel").textContent = l + " received on";
      $("e_ok").textContent = "Move to " + l;
    }
    $("e_stage").onchange = labels; labels();
    // Amex gives 20 days from the notice; suggest that unless a date was typed.
    var auto = "";
    $("e_received").onchange = function () {
      if (c.network !== "Amex" || !this.value) return;
      var due = $("e_due").value;
      if (!due || due === auto) { auto = dstr(addDays(parseDate(this.value), 20)); $("e_due").value = auto; }
    };
    $("e_cancel").onclick = closeMove;
    $("e_caseNo").focus();

    $("e_ok").onclick = function () {
      var err = $("e_err"), stage = $("e_stage").value, no = $("e_caseNo").value.trim();
      var received = $("e_received").value, due = $("e_due").value, amt = num($("e_amount").value);
      function bad(id, msg) { err.textContent = msg; $(id).focus(); }
      if (!no) return bad("e_caseNo", "Enter the case number for this stage.");
      if (!received) return bad("e_received", "Enter the date the notice was received.");
      if (!due) return bad("e_due", "Enter the respond-by date.");
      if (due < received) return bad("e_due", "Respond by cannot be before the received date.");
      if (amt <= 0) return bad("e_amount", "Enter the disputed amount.");

      var lbl = stageLabel(stage, c.network), first = STATUS_BY_STAGE[stage][0];
      var rec = norm(c);
      rec.history = rec.history.concat([{ at: received, stage: stage, status: first,
        text: lbl + " received, case " + no + ", respond by " + fmtDate(due) + "." }]);
      if (no !== c.caseNo) rec.history.push({ at: received, stage: stage,
        text: "Case number changed from " + c.caseNo + " (" + stageLabel(c.stage, c.network) + ") to " + no + "." });
      if (amt !== num(c.amount)) rec.history.push({ at: received, stage: stage,
        text: "Disputed amount changed from " + money(num(c.amount), c.currency) + " to " + money(amt, c.currency) + "." });
      rec.stageLog = rec.stageLog.concat([{ stage: stage, received: received, due: due, caseNo: no, amount: amt }]);
      rec.stage = stage; rec.status = first;
      rec.caseNo = no; rec.amount = amt; rec.dueDate = due;
      rec.checkedAt = "";   // the status-check reminder starts over for the new stage

      $("e_ok").disabled = true; err.textContent = "";
      saveCase(rec).then(function () {
        closeMove();
        state.leaveGuard = null; state.openId = null;
        app.route();   // reopen the case page with the saved version
        toast("Moved to " + lbl + ".");
      }, function (e) {
        if (e && e.status === 409) { closeMove(); showConflict(); }
        else { $("e_ok").disabled = false; err.textContent = e && e.status === 401 ? e.message : "Could not save. Nothing was changed."; }
      });
    };
  }
  if ($("moveBtn")) $("moveBtn").onclick = openMove;

  /* ---------- buttons ---------- */
  REQUIRED_FIELDS.forEach(function (r) {
    var el = $(r[0]);
    var clear = function () { el.classList.remove("invalid"); if (!document.querySelector(".invalid")) fail(""); };
    el.addEventListener("input", clear); el.addEventListener("change", clear);
  });
  $("cancelBtn").onclick = function () {
    // Cancel is an explicit "discard", so no extra question.
    if (state.leaveGuard) state.leaveGuard.discard();
    state.leaveGuard = null;
    close();
  };
  if ($("saveBtn")) $("saveBtn").onclick = function () {
    if (uploading > 0 || saving) return;
    var rec = collect(); if (!rec) return;
    saving = true; setBusy();
    saveCase(rec).then(function () {
      saving = false;
      // Removed documents keep their stored files (soft delete); only the case's list changes.
      addedIds = []; removedIds = [];
      state.leaveGuard = null;
      var outside = !inPeriod(rec);
      if (outside) { state.period = "all"; savePrefs(); }
      close();
      toast((isNew ? "Case added" : "Changes saved") + (outside ? ". Showing all time." : ""));
    }, function (e) {
      saving = false; setBusy();
      if (e && e.status === 409) showConflict();
      else if (e && e.status === 401) fail(e.message);
    });
  };
  if ($("delBtn")) $("delBtn").onclick = function () {
    if (!$("delBtn").dataset.sure) {
      $("delBtn").dataset.sure = "1"; $("delBtn").textContent = "Click again to delete"; return;
    }
    removeCase(c.id).then(function () {
      if (state.leaveGuard) state.leaveGuard.discard();   // only files uploaded during this visit and never saved
      state.leaveGuard = null;
      close(); toast("Case deleted");
    }, function (e) { if (e && e.status === 401) fail(e.message); });
  };
  if ($("emailBtn")) $("emailBtn").onclick = function () {
    tool.caseId = c.id; tool.tpl = tplFor(c);
    location.hash = "#tools";
  };
  if ($("checkedBtn")) $("checkedBtn").onclick = function () {
    var rec = norm(c);
    rec.checkedAt = todayStr();
    rec.history = (rec.history || []).concat([{ at: todayStr(), stage: rec.stage, text: "Status checked, still waiting." }]);
    $("checkedBtn").disabled = true;
    saveCase(rec).then(function () {
      c = rec;
      $("checkLive").hidden = true;
      toast("Marked as checked.");
    }, function (e) {
      $("checkedBtn").disabled = false;
      if (e && e.status === 409) showConflict();
      else if (e && e.status === 401) fail(e.message);
    });
  };

  // Remember how the form looked when opened, so leaving can warn about unsaved changes.
  var snap0 = formSnap();
  state.leaveGuard = {
    isDirty: function () { return !ro && (uploading > 0 || addedIds.length > 0 || removedIds.length > 0 || formSnap() !== snap0); },
    discard: function () { addedIds.forEach(dropAsset); addedIds = []; }
  };
  state.openId = isNew ? "new" : c.id;
}

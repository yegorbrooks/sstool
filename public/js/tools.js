// Tools tab: email templates filled from a case, opened in the Gmail composer.
import { state } from "./state.js";
import { $, esc, toast, money, num, fmtDate } from "./util.js";
import { feeIn, stageLabel, statusLabel, pastCaseNos } from "./model.js";

var EMAIL_CC = "bruce@flyluxury.com, cooper@flyluxury.com";
// Placeholders filled from the case: {saleId} {pnr} {caseNo} {amount} {lost} {product} {reason} {network} {stage} {dueDate}
var EMAIL_TEMPLATES = [
  { id: "received", label: "Chargeback received",
    subject: "Chargeback Received Sale ID: {saleId}",
    body: "Dear All,\n\nWe have received a chargeback for Sale ID: {saleId}\nAmount: {amount}\nProduct: {product}\nCB Reason: {reason}\n\n" +
          "Please provide:\n- Ticket Receipt Email\n- Any email communication with the client\nP.S. for emails with the client please use the Forward function in your gmail, and send it to special-services@flyluxury.com with Sale ID in the subject\n\nThank you." },
  { id: "won", label: "Chargeback closed, won",
    subject: "Chargeback Closed (Won) Sale ID: {saleId}",
    body: "Dear All,\n\nThe chargeback for Sale ID: {saleId} has been closed in our favour.\nAmount: {amount}\nProduct: {product}\nCB Reason: {reason}\n\n" +
          "No further action is needed. Thank you for your help." },
  { id: "lost", label: "Chargeback closed, lost",
    subject: "Chargeback Closed (Lost) Sale ID: {saleId}",
    body: "Dear All,\n\nThe chargeback for Sale ID: {saleId} has been closed against us.\nAmount: {amount}\nTotal lost incl. fees: {lost}\nProduct: {product}\nCB Reason: {reason}\n\nThank you." }
];
// What the Tools tab shows: the case picked (the case page's Email… button sets it), template and To.
export var tool = { caseId: "", tpl: "received", to: "" };

function emailMoney(n, cur) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(n || 0); }
  catch (e) { return (n || 0).toFixed(2) + " " + cur; }
}
function emailVals(c) {
  if (!c) return {};
  return { saleId: c.saleId, pnr: c.pnr, caseNo: c.caseNo, product: c.product, reason: c.reason, network: c.network,
    amount: emailMoney(num(c.amount), c.currency), lost: emailMoney(num(c.amount) + feeIn(c), c.currency),
    stage: stageLabel(c.stage, c.network), dueDate: fmtDate(c.dueDate) };
}
// Anything without a value becomes a blank line to fill in by hand.
function fillTpl(s, v) { return s.replace(/\{(\w+)\}/g, function (m, k) { return v[k] ? String(v[k]) : "______"; }); }
export function tplFor(c) {
  return !c ? "received" : c.status === "won" ? "won" : (c.status === "lost" || c.status === "accepted") ? "lost" : "received";
}
function toolCase() { return state.cases.filter(function (x) { return x.id === tool.caseId; })[0] || null; }
function caseOptLabel(c) {
  return [c.saleId ? "Sale " + c.saleId : "", c.pnr, c.caseNo ? "Case " + c.caseNo : "",
    money(num(c.amount), c.currency), statusLabel(c.status)].filter(Boolean).join(" \u00b7 ");
}
function mailList(s) { return String(s || "").split(/[,;\s]+/).filter(Boolean).join(","); }

export function renderTools() {
  $("pane_tools").innerHTML =
    '<div class="dlg tool"><h3>Email templates</h3><div class="grid">' +
      '<label class="f">Find case<input id="t_find" type="search" autocomplete="off" placeholder="Sale ID, PNR or case no."></label>' +
      '<label class="f">Case<select id="t_case"></select></label>' +
      '<label class="f">Template<select id="t_tpl">' + EMAIL_TEMPLATES.map(function (t) {
        return '<option value="' + t.id + '">' + esc(t.label) + "</option>";
      }).join("") + "</select></label>" +
      '<label class="f">To<input id="t_to" autocomplete="off"></label>' +
      '<label class="f full">Cc<input id="t_cc" autocomplete="off"></label>' +
      '<label class="f full">Subject<input id="t_subject" autocomplete="off"></label>' +
      '<label class="f full">Message<textarea id="t_body"></textarea></label>' +
    "</div>" +
    '<div class="dlg-actions"><span class="spacer"></span>' +
      '<button class="btn" type="button" id="t_copy">Copy message</button>' +
      '<button class="btn primary" type="button" id="t_gmail">Open in Gmail</button>' +
    "</div></div>";

  function regen() {
    var t = EMAIL_TEMPLATES.filter(function (x) { return x.id === tool.tpl; })[0] || EMAIL_TEMPLATES[0];
    var v = emailVals(toolCase());
    $("t_subject").value = fillTpl(t.subject, v);
    $("t_body").value = fillTpl(t.body, v);
  }
  function pickCase(id) {
    tool.caseId = id;
    tool.tpl = tplFor(toolCase());
    $("t_tpl").value = tool.tpl;
    regen();
  }
  function fillCases() {
    var q = $("t_find").value.trim().toLowerCase();
    var list = state.cases.filter(function (c) {
      return !q || [c.saleId, c.pnr, c.caseNo, pastCaseNos(c).join(" ")].join(" ").toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return (b.disputeDate || "").localeCompare(a.disputeDate || ""); });
    // Typing in Find picks the first match.
    if (q && list.length && !list.some(function (c) { return c.id === tool.caseId; })) pickCase(list[0].id);
    var cur = toolCase();
    if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    $("t_case").innerHTML = '<option value="">No case (blank template)</option>' + list.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === tool.caseId ? " selected" : "") + ">" + esc(caseOptLabel(c)) + "</option>";
    }).join("");
  }
  function parts() {
    return { to: mailList($("t_to").value), cc: mailList($("t_cc").value), su: $("t_subject").value, body: $("t_body").value.replace(/\s+$/, "") };
  }

  $("t_to").value = tool.to;
  $("t_cc").value = EMAIL_CC;
  $("t_tpl").value = tool.tpl;
  fillCases();
  regen();

  $("t_find").oninput = fillCases;
  $("t_case").onchange = function () { pickCase(this.value); };
  $("t_tpl").onchange = function () { tool.tpl = this.value; regen(); };
  $("t_to").oninput = function () { tool.to = this.value; };
  $("t_copy").onclick = function () {
    navigator.clipboard.writeText(parts().body).then(function () { toast("Message copied."); }, function () { toast("Could not copy."); });
  };
  $("t_gmail").onclick = function () {
    var p = parts(), w = 720, h = 760;
    var left = Math.round(Math.max(0, window.screenX + (window.outerWidth - w) / 2));
    var top = Math.round(Math.max(0, window.screenY + (window.outerHeight - h) / 2));
    var url = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(p.to) + "&cc=" + encodeURIComponent(p.cc) +
      "&su=" + encodeURIComponent(p.su);
    var feat = "noopener,popup,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top;
    // Copy first, open Gmail after: the browser only lets the tracker copy while it still has focus.
    navigator.clipboard.writeText(p.body).then(function () {
      window.open(url, "_blank", feat);
      toast("Message copied. Click in the Gmail message and press Ctrl+V to paste it.", 6000);
    }, function () {
      toast("Could not copy the message. Use Copy message, then paste it in Gmail.", 6000);
    });
  };
}

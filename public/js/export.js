// "Export CSV" on the Stats tab: cases in the selected period, in the current sort order.
import { state } from "./state.js";
import { stageLabel, statusLabel, netLoss } from "./model.js";
import { inPeriod } from "./period.js";
import { sortCases } from "./list.js";

function csvCell(v) {
  // Text starting with = + - @ would run as a formula in Excel; a leading ' keeps it as plain text.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  v = v == null ? "" : String(v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function saveFile(o) {
  var a = document.createElement("a"), u = URL.createObjectURL(new Blob([o.data], { type: o.type || "application/octet-stream" }));
  a.href = u; a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
}
export function exportCsv() {
  var head = ["Case", "Disputed on", "Respond by", "PNR", "Sale ID", "Source", "Product", "Travel start", "Travel end", "Order ref", "Transaction date", "Network", "Reason", "Amount", "Currency", "Dispute fees", "Fees charged", "Stage", "Status", "Net loss", "Notes"];
  var rows = sortCases(state.cases.filter(inPeriod)).map(function (c) {
    return [c.caseNo, c.disputeDate, c.dueDate, c.pnr, c.saleId, c.source, c.product, c.travelFrom, c.travelTo, c.orderRef, c.transactionDate, c.network, c.reason, c.amount, c.currency, c.fee, c.feesCharged ? "yes" : "no", stageLabel(c.stage, c.network), statusLabel(c.status), netLoss(c), c.notes].map(csvCell).join(",");
  });
  var name = "chargebacks-" + state.period + (state.period === "custom" ? "-" + (state.from || "start") + "-to-" + (state.to || "now") : "") + ".csv";
  // The leading \uFEFF tells Excel the file is UTF-8, so accents and Cyrillic show correctly.
  saveFile({ filename: name, type: "text/csv;charset=utf-8", data: "\uFEFF" + [head.join(",")].concat(rows).join("\r\n") });
}

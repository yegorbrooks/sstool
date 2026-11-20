/* ------------------------------------------------------------------
   Model: every case has a STAGE and a STATUS within that stage.

     Inquiry (RFI)      Pending / Defended / Won / Lost / Accepted
     First chargeback   Pending / Defended / Won / Lost / Accepted
     Pre-arbitration    Pending / Defended / Won / Lost / Accepted
     Arbitration        Defended / Won / Lost

   Money:
     Inquiry                 never debited, no financial impact
     First CB, Pending       debited when disputed, awaiting our decision
     Defended                credited back, can still be reversed
     Pre-arb, Pending        no new debit yet, awaiting our decision
     Won                     loss recovered, no further debits
     Lost / Accepted         amount stays (or is again) debited
     Arbitration, Lost       amount plus dispute fees debited

   Every case has its own currency. Statistics only add up cases in the
   currency selected at the top, so amounts in different currencies are
   never mixed.
------------------------------------------------------------------ */
import { num, dstr, addDays, parseDate, daysUntil } from "./util.js";
import { LEGACY_CURRENCY } from "./codes.js";

export var STAGES = {
  inquiry: { label: "Inquiry (RFI)" },
  first:  { label: "First chargeback" },
  prearb: { label: "Pre-arbitration" },
  arb:    { label: "Arbitration" }
};
// Amex has no pre-arbitration or arbitration: an optional inquiry (RFI), then a single final chargeback decision.
export function stagesFor(network) { return network === "Amex" ? ["inquiry", "first"] : ["first", "prearb", "arb"]; }
// Stages a case can move on to (Amex: inquiry → chargeback; others: first → pre-arb → arbitration).
export function laterStages(c) {
  var list = stagesFor(c.network), i = list.indexOf(c.stage);
  return i < 0 ? [] : list.slice(i + 1);
}
// Case numbers used in earlier stages (banks often issue a new one for pre-arb or arbitration).
export function pastCaseNos(c) {
  var seen = {}, out = [];
  (c.stageLog || []).forEach(function (s) {
    var n = s.caseNo;
    if (n && n !== c.caseNo && !seen[n]) { seen[n] = 1; out.push(n); }
  });
  return out;
}

export var STATUSES = {
  pending:  { label: "Pending",  kind: "act" },
  defended: { label: "Defended", kind: "review" },
  won:      { label: "Won",      kind: "won" },
  lost:     { label: "Lost",     kind: "lost" },
  accepted: { label: "Accepted", kind: "lost" }
};
export var STATUS_ORDER = ["pending", "defended", "won", "lost", "accepted"];
export var STATUS_BY_STAGE = {
  inquiry: STATUS_ORDER,
  first: STATUS_ORDER,
  prearb: STATUS_ORDER,
  arb: ["defended", "won", "lost"]
};

// Migration maps for cases saved by earlier versions of the app.
var OLD_STAGE = {
  disputed: ["first", "pending"], defended: ["first", "defended"],
  prearb: ["prearb", "pending"], prearb_defended: ["prearb", "defended"],
  arbitration: ["arb", "defended"], won: ["first", "won"], lost: ["first", "lost"]
};
var LEGACY = {
  open: ["first", "pending"], submitted: ["first", "defended"],
  accepted: ["first", "accepted"], won: ["first", "won"], lost: ["first", "lost"]
};

export function stageLabel(v, network) {
  if (network === "Amex" && v === "first") return "Chargeback";
  return STAGES[v] ? STAGES[v].label : v;
}
export function statusLabel(v) { return STATUSES[v] ? STATUSES[v].label : v; }
export function statusKind(v) { return STATUSES[v] ? STATUSES[v].kind : "act"; }

/* ---------- money per case ---------- */
// Inquiries (Amex RFI / retrieval) are never debited, so they carry no money in any total.
export function isInquiry(c) { return c.stage === "inquiry"; }
export function isClosedLoss(c) { return !isInquiry(c) && (c.status === "lost" || c.status === "accepted"); }
export function isAwaitingDebit(c) { return c.stage === "first" && c.status === "pending"; }
export function feeIn(c) { return c.feesCharged ? num(c.fee) : 0; }

// What we are currently out of pocket for this case.
export function netLoss(c) {
  if (isAwaitingDebit(c)) return num(c.amount);
  if (isClosedLoss(c)) return num(c.amount) + feeIn(c);
  return 0;
}
// Amount credited back (or not yet re-debited) that could still be reversed.
export function atRisk(c) {
  if (isInquiry(c)) return 0;
  if (c.status === "defended" || (c.stage === "prearb" && c.status === "pending")) {
    return num(c.amount) + (c.stage === "arb" ? num(c.fee) : 0);
  }
  return 0;
}

/* ---------- case normalising (also migrates cases saved by earlier versions) ---------- */
export function norm(c) {
  var o = {};
  Object.keys(c || {}).forEach(function (k) { o[k] = c[k]; });
  if (STAGES[o.stage] && STATUSES[o.status]) {
    if (STATUS_BY_STAGE[o.stage].indexOf(o.status) < 0) o.status = STATUS_BY_STAGE[o.stage][0];
  } else {
    var legacyLostFee = (o.status === "lost" || o.status === "accepted") && num(o.fee) > 0;
    var m = OLD_STAGE[o.stage] || LEGACY[o.status] || ["first", "pending"];
    var wasOldLostWithFees = o.stage === "lost" && o.feesCharged === true;
    o.stage = wasOldLostWithFees ? "arb" : m[0];
    o.status = m[1];
    if (o.feesCharged === undefined) o.feesCharged = legacyLostFee;
  }
  o.feesCharged = !!o.feesCharged;
  o.currency = o.currency || LEGACY_CURRENCY;
  o.pnr = o.pnr || ""; o.saleId = o.saleId || ""; o.product = o.product || ""; o.travelFrom = o.travelFrom || ""; o.travelTo = o.travelTo || "";
  o.transactionDate = o.transactionDate || "";
  if (!Array.isArray(o.history)) o.history = [];
  o.docs = Array.isArray(o.docs) ? o.docs : [];
  // One entry per stage the case has been through: when that stage's notice arrived and its deadline.
  if (!Array.isArray(o.stageLog) || !o.stageLog.length) {
    var rec = "";
    o.history.forEach(function (h) { if (h.stage === o.stage && h.at && (!rec || h.at < rec)) rec = h.at; });
    o.stageLog = [{ stage: o.stage, received: rec || o.disputeDate || "", due: o.dueDate || "" }];
  }
  o.stageLog = o.stageLog.map(function (s) { return Object.assign({}, s); });
  // Cases saved before stages kept their own number and amount: the current stage uses the case's values.
  var lastLog = o.stageLog[o.stageLog.length - 1];
  if (!lastLog.caseNo) lastLog.caseNo = o.caseNo || "";
  if (lastLog.amount == null || lastLog.amount === "") lastLog.amount = num(o.amount);
  return o;
}

/* ---------- reminders and deadlines ---------- */
// Follow-up after we defend: check the case 45 days after the First chargeback's
// Respond by date, 15 days after Pre-arbitration's. Arbitration: no reminder.
var FOLLOW_UP_DAYS = { inquiry: 45, first: 45, prearb: 15 };
export function followUpDays(c) { return FOLLOW_UP_DAYS[c.stage] || 0; }
function respondedOn(c) {
  if (c.status !== "defended" || !followUpDays(c)) return "";
  var at = "";
  // Only count the reply made in the current stage, so a new pre-arb defence restarts the clock.
  (c.history || []).forEach(function (h) {
    if (h.status === "defended" && (!h.stage || h.stage === c.stage) && h.at && h.at > at) at = h.at;
  });
  return at;
}
// The date the follow-up clock starts from: the stage's Respond by date, or our reply if there is none.
export function checkFrom(c) {
  if (c.status !== "defended" || !followUpDays(c)) return "";
  return c.dueDate || respondedOn(c);
}
export function followUpDate(c) {
  var b = checkFrom(c); if (!b) return "";
  var base = c.checkedAt && c.checkedAt > b ? c.checkedAt : b;
  return dstr(addDays(parseDate(base), followUpDays(c)));
}
export function needsStatusCheck(c) {
  var f = followUpDate(c);
  return !!f && daysUntil(f) <= 0;
}
function needsDecision(c) {
  return c.status === "pending" && c.dueDate;
}
// Pending cases whose decision deadline has passed or is within 7 days.
export function isUrgent(c) {
  if (!needsDecision(c)) return false;
  var d = daysUntil(c.dueDate); return d !== null && d <= 7;
}

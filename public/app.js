(function () {
  "use strict";

  /* ------------------------------------------------------------------
     Model: every case has a STAGE and a STATUS within that stage.

       First chargeback   Pending / Defended / Won / Lost / Accepted
       Pre-arbitration    Pending / Defended / Won / Lost / Accepted
       Arbitration        Defended / Won / Lost

     Money:
       First CB, Pending       debited when disputed, awaiting our decision
       Defended                credited back, can still be reversed
       Pre-arb, Pending        no new debit yet, awaiting our decision
       Won                     loss recovered, no further debits
       Lost / Accepted         amount stays (or is again) debited
       Arbitration, Lost       amount plus dispute fees debited
  ------------------------------------------------------------------ */
  var STAGES = {
    inquiry: { label: "Inquiry (RFI)" },
    first:  { label: "First chargeback" },
    prearb: { label: "Pre-arbitration" },
    arb:    { label: "Arbitration" }
  };
  var STAGE_ORDER = ["inquiry", "first", "prearb", "arb"];
  // Amex has no pre-arbitration or arbitration: an optional inquiry (RFI), then a single final chargeback decision.
  function stagesFor(network) { return network === "Amex" ? ["inquiry", "first"] : ["first", "prearb", "arb"]; }

  var STATUSES = {
    pending:  { label: "Pending",  kind: "act" },
    defended: { label: "Defended", kind: "review" },
    won:      { label: "Won",      kind: "won" },
    lost:     { label: "Lost",     kind: "lost" },
    accepted: { label: "Accepted", kind: "lost" }
  };
  var STATUS_ORDER = ["pending", "defended", "won", "lost", "accepted"];
  var STATUS_BY_STAGE = {
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

  var REASONS = ["Fraud", "Product not received", "Not as described", "Duplicate charge", "Subscription canceled", "Credit not processed", "Other"];
  var NETWORKS = ["Visa", "Mastercard", "Amex", "Other"];
  var VISA_REASONS = [
    { group: "Fraud", items: [
      ["10.1", "EMV Liability Shift Counterfeit Fraud"],
      ["10.2", "EMV Liability Shift Non-Counterfeit Fraud"],
      ["10.3", "Other Fraud: Card-Present Environment/Condition"],
      ["10.4", "Other Fraud - Card-Absent Environment"],
      ["10.5", "Visa Fraud Monitoring Program"] ] },
    { group: "Authorization", items: [
      ["11.1", "Card Recovery Bulletin"],
      ["11.2", "Declined Authorization"],
      ["11.3", "No Authorization"] ] },
    { group: "Processing errors", items: [
      ["12.1", "Late Presentment"],
      ["12.2", "Incorrect Transaction Code"],
      ["12.3", "Incorrect Currency"],
      ["12.4", "Incorrect Account Number"],
      ["12.5", "Incorrect Amount"],
      ["12.6.1", "Duplicate Processing"],
      ["12.6.2", "Paid By Other Means"],
      ["12.7", "Invalid Data"] ] },
    { group: "Consumer disputes", items: [
      ["13.1", "Merchandise/Services Not Received"],
      ["13.2", "Cancelled Recurring Transaction"],
      ["13.3", "Not As Described Or Defective Merchandise/Services"],
      ["13.4", "Counterfeit Merchandise"],
      ["13.5", "Misrepresentation"],
      ["13.6", "Credit Not Processed"],
      ["13.7", "Cancelled Merchandise / Services"],
      ["13.8", "Original Credit Transaction Not Accepted"],
      ["13.9", "Non-Receipt of Cash or Load Transaction Value"] ] }
  ];
  // Amex reason codes. Item: [code, title, what to submit (or a note when flagged), isNote].
  var AMEX_REASONS = [
    { group: "Card member disputes", items: [
      ["C02", "Credit not processed", "Proof the credit was issued, or the reason it wasn't owed."],
      ["C04", "Goods returned or refused", "Return-policy terms and proof of whether goods came back."],
      ["C05", "Goods or services cancelled", "Cancellation terms and records of what the customer agreed to."],
      ["C08", "Goods or services not received", "Delivery confirmation, tracking, or proof of service delivery."],
      ["C14", "Paid by other means", "Records showing the Amex charge was the only payment taken."],
      ["C18", "No-show or CARDeposit cancelled", "Cancellation-policy terms and the reservation record."],
      ["C28", "Cancelled recurring billing", "The cancellation date and proof billing stopped on time."],
      ["C31", "Not as described", "The listing, order details, and what was actually delivered."],
      ["C32", "Damaged or defective", "Proof the item shipped in good condition and any return record."],
      ["M10", "Vehicle rental, capital damages", "Rental agreement, condition reports, and damage evidence."],
      ["M49", "Vehicle rental, theft or loss of use", "Rental agreement, police or incident report, and loss records."] ] },
    { group: "Fraud", items: [
      ["F10", "Missing imprint", "The imprint record or proof of a valid card-present method."],
      ["F14", "Missing signature", "The signed receipt or proof of an approved no-signature method."],
      ["F24", "No cardmember authorisation", "Proof of authorization, AVS or CVV match, and prior use."],
      ["F29", "Card not present", "IP, device, delivery, and history tying the buyer to the card."],
      ["F30", "EMV counterfeit", "Proof the terminal read the chip rather than the magstripe."],
      ["F31", "EMV lost, stolen, or not received", "Proof of a valid chip-and-PIN transaction."] ] },
    { group: "Processing errors", items: [
      ["P01", "Unassigned card number", "Proof the number was valid and correctly captured."],
      ["P03", "Credit processed as charge", "Records showing the correct transaction type."],
      ["P04", "Charge processed as credit", "Records showing the intended and actual transaction type."],
      ["P05", "Incorrect charge amount", "The agreed price and proof of what the customer approved."],
      ["P07", "Late submission", "Proof the charge was submitted on time."],
      ["P08", "Duplicate charge", "Records showing each charge was a separate valid sale."],
      ["P22", "Non-matching card number", "Proof the same card was authorized and charged."],
      ["P23", "Currency discrepancy", "Proof of the agreed currency and the amount shown."] ] },
    { group: "Authorization", items: [
      ["A01", "Charge exceeds authorisation", "The authorization record and the final agreed amount."],
      ["A02", "No valid authorisation", "Proof of a valid, approved authorization."],
      ["A08", "Authorisation approval expired", "Proof the charge settled while the approval was valid."] ] },
    { group: "Chargeback programs", items: [
      ["FR2", "Fraud Full Recourse Program", "Amex charges back fraud disputes by default for enrolled merchants. You still have 20 days to respond.", true],
      ["FR4", "Immediate Chargeback Program", "Amex charges back without an inquiry first. Refund within 7 calendar days to prevent the chargeback; you still have 20 days to respond.", true],
      ["FR6", "Partial Immediate Chargeback Program", "A partial version of the immediate chargeback default. The same 7-calendar-day refund window applies.", true] ] },
    { group: "Inquiry follow-up and other", items: [
      ["R03", "Insufficient reply", "Your reply to an inquiry lacked enough detail. Answer inquiries fully, with all requested records.", true],
      ["R13", "No reply", "No reply reached Amex within the inquiry window. Track inquiry deadlines and reply on time.", true],
      ["M01", "Chargeback authorisation", "You authorized the chargeback in advance. Confirm before agreeing to any chargeback authorization.", true] ] }
  ];
  var DEFAULT_AMEX_REASON = "F29 Card not present";
  function amexReasonInfo(code) {
    for (var g = 0; g < AMEX_REASONS.length; g++)
      for (var i = 0; i < AMEX_REASONS[g].items.length; i++)
        if (AMEX_REASONS[g].items[i][0] === code) return AMEX_REASONS[g].items[i];
    return null;
  }
  var DEFAULT_VISA_REASON = "10.4 Other Fraud - Card-Absent Environment";
  // Visa and Amex use their own reason codes; other networks keep the general list.
  function reasonOptions(network, sel) {
    var html, values = [];
    var groups = network === "Visa" ? VISA_REASONS : network === "Amex" ? AMEX_REASONS : null;
    if (groups) {
      html = groups.map(function (g) {
        return '<optgroup label="' + esc(g.group) + '">' + g.items.map(function (it) {
          var v = it[0] + " " + it[1]; values.push(v);
          return '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(v) + "</option>";
        }).join("") + "</optgroup>";
      }).join("");
    } else {
      values = REASONS.slice();
      html = opts(REASONS, sel);
    }
    // Keep a value saved earlier (e.g. an old general reason) instead of silently changing it.
    if (sel && values.indexOf(sel) < 0) html = '<option value="' + esc(sel) + '" selected>' + esc(sel) + "</option>" + html;
    return html;
  }
  // Documents Amex asks for when we respond (which ones apply depends on the reason code).
  var AMEX_EVIDENCE = [
    ["roc", "Signed record of charge (ROC) or digital authorization"],
    ["terms", "Terms and conditions / cancellation policy"],
    ["delivery", "Proof of delivery or tracking tied to the billing address"],
    ["comms", "Customer communication logs"]
  ];
  var PRODUCTS = ["Ticket Cost", "Ticket Protection", "Service Fee", "Tips", "Service Fee + Ticket Protection + Tips", "Service Fee + Tips", "Service Fee + Ticket Protection", "Ticket Protection + Tips", "Full Cost"];
  var SOURCES = ["IPS", "Merlink", "Airline"];
  var CURRENCIES = ["USD", "EUR", "GBP", "MDL", "RON"];
  // Case documents. The assets store accepts only these file types.
  var DOC_EXT = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", csv: "text/csv", md: "text/markdown", json: "application/json", txt: "text/plain" };
  var DOC_ACCEPT = Object.keys(DOC_EXT).map(function (e) { return "." + e; }).join(",");
  function docExt(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  var DOC_ERR = { too_large: "is over the 50 MB limit", unsupported_type: "is not a supported file type", quota_or_state: "could not be stored: storage is full", not_granted: "could not be uploaded: no permission", rate_limited: "was rate limited, try again in a moment" };

  var state = {
    cases: [],
    period: "30d",
    from: "",
    to: "",
    sortKey: "disputeDate",
    sortDir: "desc",
    statFlip: false,
    stage: "all",
    status: "all",
    q: "",
    currency: "USD",
    canWrite: true,
    db: null,
    assets: null,
    loaded: false,
    openId: null
  };

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function monthKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseDate(s) {
    if (!s) return null;
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function fmtDate(s) {
    var d = parseDate(s);
    return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  }
  function monthLabel(k) {
    var p = k.split("-");
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  function money(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: state.currency }).format(n || 0);
    } catch (e) { return (n || 0).toFixed(2) + " " + state.currency; }
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function stageLabel(v, network) {
    if (network === "Amex" && v === "first") return "Chargeback";
    return STAGES[v] ? STAGES[v].label : v;
  }
  function statusLabel(v) { return STATUSES[v] ? STATUSES[v].label : v; }
  function statusKind(v) { return STATUSES[v] ? STATUSES[v].kind : "act"; }
  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fmtShort(s) {
    var d = parseDate(s);
    return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  }
  function fmtRange(a, b) {
    if (a && b && a !== b) return fmtShort(a) + " \u2013 " + fmtDate(b);
    return fmtDate(a || b);
  }
  // Sale ID comes from the internal CRM and links to the sale's edit page.
  function crmUrl(id) { return "https://crm.flyluxury.com/sales/" + encodeURIComponent(String(id).trim()) + "/edit"; }
  function crmLink(id) {
    return '<a class="crm" href="' + esc(crmUrl(id)) + '" target="_blank" rel="noopener">' + esc(id) + "</a>";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function daysUntil(s) {
    var d = parseDate(s); if (!d) return null;
    var t = parseDate(todayStr());
    return Math.round((d - t) / 86400000);
  }
  var toastTimer;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  /* ---------- money per case ---------- */
  function isClosedLoss(c) { return c.status === "lost" || c.status === "accepted"; }
  function isAwaitingDebit(c) { return c.stage === "first" && c.status === "pending"; }
  function feeIn(c) { return c.feesCharged ? num(c.fee) : 0; }

  // What we are currently out of pocket for this case.
  function netLoss(c) {
    if (isAwaitingDebit(c)) return num(c.amount);
    if (isClosedLoss(c)) return num(c.amount) + feeIn(c);
    return 0;
  }
  // Amount credited back (or not yet re-debited) that could still be reversed.
  function atRisk(c) {
    if (c.stage === "inquiry") return 0;   // nothing has been debited yet
    if (c.status === "defended" || (c.stage === "prearb" && c.status === "pending")) {
      return num(c.amount) + (c.stage === "arb" ? num(c.fee) : 0);
    }
    return 0;
  }
  function amexExplain(key, a) {
    switch (key) {
      case "inquiry:pending": return "Amex sent an inquiry (RFI). Nothing is debited yet. We have 20 days to respond with documentation; if we do not, or the proof is insufficient, it becomes a chargeback and " + a + " is debited.";
      case "inquiry:defended": return "We responded to the inquiry. Nothing is debited while Amex reviews it. If it is not resolved in our favour it becomes a chargeback.";
      case "inquiry:won": return "Amex closed the inquiry in our favour. No debit.";
      case "inquiry:lost": return "The inquiry was not resolved in our favour and " + a + " was debited. Final loss.";
      case "inquiry:accepted": return "We accepted the inquiry. " + a + " is a final loss.";
      case "first:pending": return "Amex debited " + a + " (direct chargeback, or after an inquiry). We have 20 days from the notice to respond with documentation; if we do not, or the proof is insufficient, the chargeback stands.";
      case "first:defended": return "We responded. " + a + " was credited back while Amex reviews, usually 6 to 8 weeks. Amex has no pre-arbitration or arbitration, so its decision is final.";
      case "first:won": return "Amex decided in our favour. Loss recovered.";
      case "first:lost": return "Amex decided for the cardmember. " + a + " stays debited. Final loss, no further appeal.";
      case "first:accepted": return "We accepted the chargeback. " + a + " stays debited as a final loss.";
    }
    return "";
  }
  function explain(c) {
    var a = money(num(c.amount));
    var fee = num(c.fee);
    if (c.network === "Amex") { var ax = amexExplain(c.stage + ":" + c.status, a); if (ax) return ax; }
    switch (c.stage + ":" + c.status) {
      case "first:pending": return "We were debited " + a + " when the dispute was raised. Accepting keeps the loss; defending gets the amount credited back.";
      case "first:defended": return a + " was credited back. The bank is reviewing our defence and may still reverse it.";
      case "first:won": return "The bank accepted our defence. Loss recovered.";
      case "first:lost": return "The bank rejected our defence and debited " + a + " again. Final loss.";
      case "first:accepted": return "We accepted the dispute. " + a + " stays debited as a final loss.";
      case "prearb:pending": return "The bank started pre-arbitration. There is no new debit yet. Accepting debits " + a + " again; defending keeps the credit.";
      case "prearb:defended": return "We defended pre-arbitration. The credit stays while the bank reviews; it may escalate to arbitration.";
      case "prearb:won": return "The bank accepted our defence. No further debits.";
      case "prearb:lost": return "Pre-arbitration was lost. " + a + " is debited again. Final loss.";
      case "prearb:accepted": return "We accepted pre-arbitration. " + a + " is debited again. Final loss.";
      case "arb:defended": return "The card brand is deciding. If it rules for the cardholder we are debited " + a + (fee ? " plus " + money(fee) + " in dispute fees." : " plus the dispute fees.");
      case "arb:won": return "The card brand ruled for the merchant. No further debits.";
      case "arb:lost": return "The card brand ruled for the cardholder. " + a + (fee ? " plus " + money(fee) + " in dispute fees" : " plus dispute fees") + " debited. Final loss.";
    }
    return "";
  }

  /* ---------- case normalising (also migrates cases saved by earlier versions) ---------- */
  function norm(c) {
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
    o.pnr = o.pnr || ""; o.saleId = o.saleId || ""; o.product = o.product || ""; o.travelFrom = o.travelFrom || ""; o.travelTo = o.travelTo || "";
    o.transactionDate = o.transactionDate || ""; o.evidence = (o.evidence && typeof o.evidence === "object") ? o.evidence : {};
    if (!Array.isArray(o.history)) o.history = [];
    o.docs = Array.isArray(o.docs) ? o.docs : [];
    return o;
  }

  /* ---------- storage ---------- */
  var LS_CASES = "chargebacks:cases:v1";
  var LS_PREFS = "chargebacks:prefs:v1";

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      if (!r.ok) throw new Error("Server answered " + r.status);
      return r.json();
    });
  }
  function saveCase(c) {
    c.updatedAt = Date.now();
    return api("PUT", "/api/cases/" + encodeURIComponent(c.id), c).then(function () {
      var i = state.cases.findIndex(function (x) { return x.id === c.id; });
      if (i >= 0) state.cases[i] = norm(c); else state.cases.push(norm(c));
      renderAll();
    }, function (e) { toast("Could not save: " + e.message); throw e; });
  }
  function removeCase(id) {
    return api("DELETE", "/api/cases/" + encodeURIComponent(id)).then(function () {
      state.cases = state.cases.filter(function (x) { return x.id !== id; });
      renderAll();
    }, function (e) { toast("Could not delete: " + e.message); throw e; });
  }
  function loadCases(first) {
    return api("GET", "/api/cases").then(function (list) {
      state.cases = list.map(norm); state.loaded = true;
      if (first) { renderAll(); route(); } else if (state.openId == null && $("detailView").hidden) renderAll();
    }, function () { if (first) { state.loaded = true; renderAll(); route(); toast("Could not load cases. Sign in again or reload."); } });
  }
  function initStorage() {
    state.assets = {
      upload: function (f, o) {
        return fetch("/api/files", { method: "POST", headers: { "x-filename": encodeURIComponent(f.name), "content-type": (o && o.type) || "application/octet-stream" }, body: f })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || "upload failed"); e.code = j.code; throw e; } return j; }); });
      },
      delete: function (id) { return fetch("/api/files/" + id, { method: "DELETE" }); }
    };
    state.downloads = { save: function (o) {
      var a = document.createElement("a"), u = URL.createObjectURL(new Blob([o.data]));
      a.href = u; a.download = o.filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 2000); return Promise.resolve();
    } };
    $("exportBtn").hidden = false;
    loadCases(true);
    setInterval(function () { if (!document.hidden) loadCases(false); }, 30000);
  }

  /* ---------- stats ---------- */
  var PERIODS = [["7d", "Last 7 days"], ["30d", "Last 30 days"], ["month", "This month"], ["1y", "Last 12 months"], ["ytd", "Year to date"], ["all", "All time"], ["custom", "Custom range"]];
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dstr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  // Inclusive date range for the selected period. An empty bound means open-ended.
  function periodRange() {
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
  function periodText() {
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
  function inPeriod(c) {
    var r = periodRange(), d = c.disputeDate || "";
    if (r.from && d < r.from) return false;
    if (r.to && d > r.to) return false;
    return true;
  }
  function computeStats(list) {
    var s = { count: list.length, disputed: 0, won: 0, wonCount: 0, lostAmt: 0, fees: 0, lostCount: 0,
              awaiting: 0, awaitCount: 0, atRisk: 0, reviewAmt: 0, reviewCount: 0, decided: 0 };
    list.forEach(function (c) {
      var a = num(c.amount);
      s.disputed += a;
      if (c.status === "won") { s.won += a; s.wonCount++; s.decided++; }
      else if (isClosedLoss(c)) { s.lostAmt += a; s.fees += feeIn(c); s.lostCount++; s.decided++; }
      else if (isAwaitingDebit(c)) { s.awaiting += a; s.awaitCount++; }
      else { s.reviewAmt += a; s.reviewCount++; s.atRisk += atRisk(c); }
    });
    s.netLoss = s.lostAmt + s.fees + s.awaiting;
    s.winRate = s.decided ? s.wonCount / s.decided : null;
    return s;
  }

  /* ---------- render ---------- */
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
    $("stageFilter").innerHTML = '<option value="all">All stages</option>' + STAGE_ORDER.map(function (k) {
      return '<option value="' + k + '"' + (state.stage === k ? " selected" : "") + ">" + esc(STAGES[k].label) + "</option>";
    }).join("");
    $("statusFilter").innerHTML = '<option value="all">All statuses</option>' + STATUS_ORDER.map(function (k) {
      return '<option value="' + k + '"' + (state.status === k ? " selected" : "") + ">" + esc(STATUSES[k].label) + "</option>";
    }).join("");
    $("newBtn").disabled = !state.canWrite;
  }

  function renderStats() {
    var s = computeStats(state.cases.filter(inPeriod));
    var label = "Net loss, " + periodText();

    var sub = "Disputes: " + money(s.lostAmt + s.awaiting) + ", Fees: " + money(s.fees);

    var inP = state.cases.filter(inPeriod);
    var facts =
      '<div class="facts">' +
        fact(label, money(s.netLoss), sub, s.netLoss ? "loss" : "") +
        fact("Total disputed", money(s.disputed), plural(s.count, "case", "cases"), "") +
        fact("Recovered (won)", money(s.won), plural(s.wonCount, "case", "cases"), "win") +
        fact("Credited back, still at risk", money(s.atRisk), plural(s.reviewCount, "case", "cases") + " in review", "wait") +
      "</div>";
    var card = '<div class="statcard' + (state.statFlip ? " flip" : "") + '" id="statCard" tabindex="0" role="group" aria-label="Disputed amount by outcome. Hover or focus to see totals.">' +
      '<div class="face front">' + outcomeDonut(s) + '</div><div class="face back">' + facts + "</div></div>";
    var charts = '<div class="charts">' +
      winCard(s) +
      chartCard("Dispute reasons", inP, function (c) { return c.reason; }) +
      chartCard("Products", inP, function (c) { return c.product; }) +
      trendCards(inP) +
    "</div>";

    $("statsArea").innerHTML = '<div class="stats">' + card + charts + "</div>";
    var sc = $("statCard");
    if (sc) sc.onclick = function () {
      if (window.matchMedia && matchMedia("(hover: none)").matches) { state.statFlip = !state.statFlip; sc.classList.toggle("flip", state.statFlip); }
    };
  }
  function fact(k, v, n, cls) {
    return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v ' + cls + '">' + esc(v) + '</div><div class="n">' + esc(n) + "</div></div>";
  }

  // Default face of the numbers card: disputed amount split by outcome.
  function outcomeDonut(s) {
    var segs = [
      { label: "Won", n: s.won, color: "var(--win)", op: 1 },
      { label: "Lost or accepted", n: s.lostAmt, color: "var(--loss)", op: 1 },
      { label: "Pending", n: s.awaiting + s.reviewAmt, color: "var(--wait)", op: 1 }
    ];
    var total = segs.reduce(function (t, x) { return t + x.n; }, 0);
    var R = 48, C = 2 * Math.PI * R, off = 0;
    var arcs = total > 0 ? segs.map(function (x) {
      if (!x.n) return "";
      var len = C * x.n / total;
      var el = '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + x.color + '" stroke-opacity="' + x.op + '" stroke-width="14" stroke-dasharray="' + len + " " + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 60 60)"></circle>';
      off += len; return el;
    }).join("") : "";
    var big = moneyCompact(s.disputed);
    var summary = "Disputed " + money(s.disputed) + ": " + segs.map(function (x) { return x.label + " " + money(x.n); }).join(", ");
    var svg = '<svg viewBox="0 0 120 120" role="img" aria-label="' + esc(summary) + '">' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="var(--neutral-bg)" stroke-width="14"></circle>' + arcs +
      '<text class="pct" x="60" y="62" text-anchor="middle" style="font-size:' + (big.length > 5 ? 17 : 22) + 'px">' + esc(big) + "</text>" +
      '<text class="pctl" x="60" y="77" text-anchor="middle">disputed</text></svg>';
    var legend = '<ul class="clegend olegend">' + segs.map(function (x) {
      return '<li><i class="dot" style="background:' + x.color + ';opacity:' + x.op + '"></i><span class="cl">' + esc(x.label) + '</span><span class="cp">' + esc(money(x.n)) + "</span></li>";
    }).join("") + "</ul>";
    return svg + legend + '<p class="flip-hint"><span class="h-hover">Hover for totals</span><span class="h-tap">Tap for totals</span></p>';
  }
  // Generic donut card: segs = [{label, n, color?}], total = sum used for percentages.
  function donutCard(title, segs, total, big, small) {
    var head = "<h3>" + esc(title) + "</h3>";
    var R = 48, C = 2 * Math.PI * R, off = 0;
    var arcs = segs.map(function (s, i) {
      s.color = s.color || (s.other ? "var(--c8)" : "var(--c" + (i + 1) + ")");
      var len = C * s.n / total;
      var el = '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="14" stroke-dasharray="' + len + " " + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 60 60)"></circle>';
      off += len; return el;
    }).join("");
    var summary = title + ": " + segs.map(function (s) { return s.label + " " + Math.round(s.n / total * 100) + "%"; }).join(", ");
    var svg = '<svg viewBox="0 0 120 120" role="img" aria-label="' + esc(summary) + '">' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="var(--neutral-bg)" stroke-width="14"></circle>' + arcs +
      '<text class="pct" x="60" y="62" text-anchor="middle">' + esc(big) + "</text>" +
      '<text class="pctl" x="60" y="77" text-anchor="middle">' + esc(small) + "</text></svg>";
    var legend = '<ul class="clegend">' + segs.map(function (s) {
      return '<li><i class="dot" style="background:' + s.color + '"></i><span class="cl" title="' + esc(s.label) + '">' + esc(s.label) + "</span>" +
        '<span class="cp">' + Math.round(s.n / total * 100) + '%</span><span class="cn">' + s.n + "</span></li>";
    }).join("") + "</ul>";
    return '<div class="chartcard">' + head + '<div class="chartbody">' + svg + legend + "</div></div>";
  }
  function emptyCard(title, msg) {
    return '<div class="chartcard"><h3>' + esc(title) + '</h3><p class="muted chart-empty">' + esc(msg) + "</p></div>";
  }
  function chartCard(title, list, keyFn) {
    var counts = {}, order = [], total = list.length;
    list.forEach(function (c) {
      var k = keyFn(c) || "Not set";
      if (!(k in counts)) { counts[k] = 0; order.push(k); }
      counts[k]++;
    });
    if (!total) return emptyCard(title, "No cases in this period.");
    order.sort(function (x, y) { return counts[y] - counts[x] || x.localeCompare(y); });
    var segs = order.map(function (k) { return { label: k, n: counts[k] }; });
    if (segs.length > 7) {
      var rest = segs.slice(6).reduce(function (t, s) { return t + s.n; }, 0);
      segs = segs.slice(0, 6).concat([{ label: "Other", n: rest, other: true }]);
    }
    return donutCard(title, segs, total, String(total), total === 1 ? "case" : "cases");
  }
  function moneyCompact(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: state.currency, notation: "compact", maximumFractionDigits: 1 }).format(n);
    } catch (e) { return money(n); }
  }
  function niceMax(x) {
    if (x <= 0) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }
  // Buckets disputes by day, week or month depending on the span of the selected period.
  function buildBuckets(list) {
    var dates = list.map(function (c) { return c.disputeDate; }).filter(Boolean).sort();
    if (!dates.length) return null;
    var r = periodRange(), today = todayStr();
    var startS = r.from || dates[0];
    var endS = r.to || (dates[dates.length - 1] > today ? dates[dates.length - 1] : today);
    var span = Math.round((parseDate(endS) - parseDate(startS)) / 86400000) + 1;
    var mode = span <= 31 ? "day" : span <= 140 ? "week" : "month";
    var cur = parseDate(startS), end = parseDate(endS);
    if (mode === "week") cur = addDays(cur, -((cur.getDay() + 6) % 7));
    if (mode === "month") cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
    function keyOf(s) {
      if (mode === "day") return s;
      if (mode === "month") return s.slice(0, 7);
      var d = parseDate(s); return dstr(addDays(d, -((d.getDay() + 6) % 7)));
    }
    var buckets = [], idx = {};
    while (cur <= end && buckets.length < 400) {
      var key = mode === "month" ? dstr(cur).slice(0, 7) : dstr(cur);
      idx[key] = buckets.length;
      buckets.push({ date: new Date(cur), amt: 0, n: 0 });
      cur = mode === "day" ? addDays(cur, 1) : mode === "week" ? addDays(cur, 7) : new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    var total = 0;
    list.forEach(function (c) {
      if (!c.disputeDate) return;
      var i = idx[keyOf(c.disputeDate)];
      total += num(c.amount);
      if (i != null) { buckets[i].amt += num(c.amount); buckets[i].n++; }
    });
    return { buckets: buckets, mode: mode, total: total,
             per: mode === "day" ? "per day" : mode === "week" ? "per week" : "per month" };
  }
  function bucketWhen(mode, b) {
    return mode === "month" ? b.date.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : mode === "week" ? "Week of " + fmtDate(dstr(b.date)) : fmtDate(dstr(b.date));
  }
  function bucketLabel(mode, b) {
    return mode === "month" ? b.date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : fmtShort(dstr(b.date));
  }
  function xTicks(mode, buckets) {
    var step = Math.ceil(buckets.length / 8), out = "";
    buckets.forEach(function (b, i) {
      if (i % step === 0) out += '<span style="left:' + ((i + 0.5) / buckets.length * 100).toFixed(2) + '%">' + esc(bucketLabel(mode, b)) + "</span>";
    });
    return out;
  }
  function chartFrame(title, note, ylabels, plot, ticks) {
    return '<div class="chartcard trendcard"><div class="trendhead"><h3>' + esc(title) + '</h3><span class="muted">' + esc(note) + "</span></div>" +
      '<div class="trendplot" role="img" aria-label="' + esc(title + ": " + note) + '">' +
        '<div class="yaxis"><span>' + esc(ylabels[0]) + "</span><span>" + esc(ylabels[1]) + "</span><span>0</span></div>" +
        plot + '<div class="xaxis">' + ticks + "</div></div></div>";
  }

  // Two line charts side by side: how many disputes came in and how much money they total.
  function trendCards(list) {
    var d = buildBuckets(list);
    if (!d) return '<div class="chartcard trendcard"><h3>Disputes received</h3><p class="muted chart-empty">No disputes in this period.</p></div>';
    var B = d.buckets, n = B.length, mode = d.mode;
    var ticks = xTicks(mode, B);

    // Shared line plot: values[i] against a 0..top scale, one point per bucket.
    function linePlot(values, top, tipFn, cls) {
      var pts = values.map(function (v, i) { return [(i + 0.5) / n * 100, 100 - v / top * 100]; });
      var line = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
      var area = line + " L" + pts[n - 1][0].toFixed(2) + " 100 L" + pts[0][0].toFixed(2) + " 100 Z";
      var cols = values.map(function (v, i) {
        return '<div class="bar" title="' + esc(tipFn(B[i])) + '"><b class="pt' + (n <= 40 ? " on" : "") + '" style="bottom:' + (v / top * 100).toFixed(2) + '%"></b></div>';
      }).join("");
      return '<div class="plot lineplot ' + cls + '"><div class="gridlines"><i></i><i></i><i></i></div>' +
        '<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="' + area + '"></path><path class="line" d="' + line + '"></path></svg>' +
        '<div class="bars">' + cols + "</div></div>";
    }

    // 1) Number of disputes received
    var maxN = Math.max.apply(null, B.map(function (b) { return b.n; }));
    var topN = maxN <= 20 ? Math.max(2, Math.ceil(maxN / 2) * 2) : niceMax(maxN);
    var c1 = chartFrame("Disputes received", plural(list.length, "dispute", "disputes") + ", " + d.per,
      [String(topN), String(Math.round(topN / 2))],
      linePlot(B.map(function (b) { return b.n; }), topN, function (b) { return bucketWhen(mode, b) + ": " + plural(b.n, "dispute", "disputes"); }, "count"), ticks);

    // 2) Disputed amount
    var maxA = niceMax(Math.max.apply(null, B.map(function (b) { return b.amt; })));
    var c2 = chartFrame("Disputed amount", money(d.total) + " total, " + d.per,
      [moneyCompact(maxA), moneyCompact(maxA / 2)],
      linePlot(B.map(function (b) { return b.amt; }), maxA, function (b) { return bucketWhen(mode, b) + ": " + money(b.amt) + " disputed"; }, "amount"), ticks);

    return '<div class="trendrow">' + c1 + c2 + "</div>";
  }
  function winCard(s) {
    if (!s.decided) return emptyCard("Win rate", "No closed cases yet.");
    var segs = [{ label: "Won", n: s.wonCount, color: "var(--win)" }];
    if (s.lostCount) segs.push({ label: "Lost or accepted", n: s.lostCount, color: "var(--loss)" });
    return donutCard("Win rate", segs, s.decided, Math.round(s.winRate * 100) + "%", "win rate");
  }

  // Follow-up: 60 days after we replied (status "Defended"), remind us to check the case.
  var FOLLOW_UP_DAYS = 60;
  function respondedOn(c) {
    if (c.status !== "defended") return "";
    var at = "";
    (c.history || []).forEach(function (h) { if (h.status === "defended" && h.at && h.at > at) at = h.at; });
    return at;
  }
  function followUpDate(c) {
    var r = respondedOn(c); if (!r) return "";
    var base = c.checkedAt && c.checkedAt > r ? c.checkedAt : r;
    return dstr(addDays(parseDate(base), FOLLOW_UP_DAYS));
  }
  function needsStatusCheck(c) {
    var f = followUpDate(c);
    return !!f && daysUntil(f) <= 0;
  }
  function needsDecision(c) {
    return c.status === "pending" && c.dueDate;
  }
  function renderAlert() {
    var html = "";
    var urgent = state.cases.filter(function (c) {
      if (!needsDecision(c)) return false;
      var d = daysUntil(c.dueDate); return d !== null && d <= 7;
    });
    if (urgent.length) {
      var late = urgent.filter(function (c) { return daysUntil(c.dueDate) < 0; }).length;
      var msg = late
        ? plural(late, "case is", "cases are") + " past the deadline for our decision" + (urgent.length > late ? ", and " + (urgent.length - late) + " more due within 7 days." : ".")
        : plural(urgent.length, "case needs", "cases need") + " our decision within 7 days.";
      html += '<div class="alert' + (late ? " hot" : "") + '"><span>' + esc(msg) + '</span><button id="showUrgent">Show them</button></div>';
    }
    var check = state.cases.filter(needsStatusCheck);
    if (check.length) {
      html += '<div class="alert"><span>' + esc(plural(check.length, "case was", "cases were") + " replied to " + FOLLOW_UP_DAYS + " or more days ago. Check " + (check.length === 1 ? "its" : "their") + " status.") + '</span><button id="showCheck">Show them</button></div>';
    }
    var area = $("alertArea");
    area.innerHTML = html;
    if ($("showUrgent")) $("showUrgent").onclick = function () {
      state.period = "all"; state.stage = "all"; state.status = "pending"; state.q = ""; $("search").value = ""; renderAll();
    };
    if ($("showCheck")) $("showCheck").onclick = function () {
      state.period = "all"; state.stage = "all"; state.status = "defended"; state.q = ""; $("search").value = ""; renderAll();
    };
  }

  function filteredCases() {
    var q = state.q.trim().toLowerCase();
    return state.cases.filter(function (c) {
      if (!inPeriod(c)) return false;
      if (state.stage !== "all" && c.stage !== state.stage) return false;
      if (state.status !== "all" && c.status !== state.status) return false;
      if (q) {
        var hay = [c.caseNo, c.customer, c.pnr, c.saleId, c.product, c.orderRef, c.reason, c.network, c.notes].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
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

  var DEFAULT_DIR = { amount: "desc", disputeDate: "desc", dueDate: "asc" };
  function setSort(key) {
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = DEFAULT_DIR[key] || "desc"; }
    state.refocus = key;
    savePrefs();
    renderTable();
  }
  function sortTh(key, label, cls) {
    var on = state.sortKey === key, asc = state.sortDir === "asc";
    return '<th class="' + (cls || "") + '" aria-sort="' + (on ? (asc ? "ascending" : "descending") : "none") + '">' +
      '<button type="button" class="sortbtn' + (on ? " on" : "") + '" data-sort="' + key + '">' + esc(label) +
      '<span class="arr" aria-hidden="true">' + (on ? (asc ? "\u25B2" : "\u25BC") : "\u2195") + "</span></button></th>";
  }

  function renderTable() {
    var list = filteredCases();
    $("listTitle").textContent = "Cases (" + list.length + ")";
    var area = $("tableArea");
    if (!state.cases.length) {
      area.innerHTML = '<div class="empty"><p>No cases yet. Add your first chargeback to start tracking.</p>' +
        (state.canWrite ? '<button class="btn primary" id="emptyAdd">Add case</button>' : "") + "</div>";
      var eb = $("emptyAdd"); if (eb) eb.onclick = function () { location.hash = "#new"; };
      return;
    }
    if (!list.length) {
      area.innerHTML = '<div class="empty"><p>No cases match these filters.</p></div>';
      return;
    }
    var rows = list.map(function (c) {
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
        '<td class="num">' + esc(money(num(c.amount))) + "</td>" +
        "<td>" + esc(fmtDate(c.disputeDate)) + "</td>" +
        "<td>" + due + "</td>" +
        "<td>" + esc(fmtRange(c.travelFrom, c.travelTo)) + "</td>" +
        "<td>" + esc(stageLabel(c.stage, c.network)) + (needsStatusCheck(c) ? ' <span class="pill act">Check status</span>' : "") + "</td></tr>";
    }).join("");
        area.innerHTML = "<table><thead><tr><th>PNR</th><th>Sale ID</th><th>Source</th>" +
      sortTh("amount", "Amount", "num") + sortTh("disputeDate", "Disputed date") + sortTh("dueDate", "Due date") +
      "<th>Travel date</th><th>Dispute cycle</th></tr></thead><tbody>" + rows + "</tbody></table>";
    Array.prototype.forEach.call(area.querySelectorAll("th button[data-sort]"), function (btn) {
      btn.onclick = function () { setSort(btn.getAttribute("data-sort")); };
    });
    if (state.refocus) {
      var rb = area.querySelector('th button[data-sort="' + state.refocus + '"]');
      if (rb) rb.focus();
      state.refocus = null;
    }
    Array.prototype.forEach.call(area.querySelectorAll("a.crm"), function (a) {
      a.onclick = function (e) { e.stopPropagation(); };
    });
    Array.prototype.forEach.call(area.querySelectorAll("tbody tr"), function (tr) {
      var open = function () { location.hash = "#case/" + encodeURIComponent(tr.getAttribute("data-id")); };
      tr.onclick = open;
      tr.onkeydown = function (e) { if (e.target !== tr) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
  }

  function renderAll() {
    if (!state.loaded) return;
    renderControls(); renderStats(); renderAlert(); renderTable();
  }

  /* ---------- dialog ---------- */
  function opts(arr, sel) {
    return arr.map(function (x) {
      return '<option value="' + esc(x) + '"' + (x === sel ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
  }
  function productOpts(sel) {
  var html = opts(PRODUCTS, sel);
  if (sel && PRODUCTS.indexOf(sel) < 0) html = '<option value="' + esc(sel) + '" selected>' + esc(sel) + "</option>" + html;
  return html;
}
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
      return '<li><span class="when">' + esc(fmtDate(h.at)) + "</span><span>" + esc(h.text) + "</span></li>";
    }).join("") + "</ol></div>";
  }

  /* ---------- document viewer ---------- */
  var viewTok = 0;
  function downloadDoc(d) {
    var a = document.createElement("a"); a.href = "/api/files/" + d.id + "?download=1"; document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadDocOld(d) {
    if (!state.downloads) { toast("Downloads are not available in this view."); return; }
    fetch("/api/files/" + d.id).then(function (r) {
      if (!r.ok) throw new Error("missing");
      return r.blob();
    }).then(function (blob) {
      return state.downloads.save({ filename: d.name, data: blob });
    }).then(function () {}, function (e) {
      if (e && e.code === "declined") return;
      toast("Could not download " + d.name + ".");
    });
  }
  function closeViewer() {
    viewTok++;
    var v = $("docViewer"); if (v) v.remove();
    document.removeEventListener("keydown", viewerKey);
  }
  function viewerKey(e) { if (e.key === "Escape") closeViewer(); }
  function openViewer(d) {
    closeViewer();
    var tok = ++viewTok, ext = docExt(d.name), url = "/api/files/" + d.id;
    var v = document.createElement("div");
    v.id = "docViewer"; v.className = "viewer"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", d.name);
    v.innerHTML = '<div class="vbar"><strong class="vname"></strong><span class="spacer"></span>' +
      '<button class="btn" type="button" id="vDl">Download</button><button class="btn primary" type="button" id="vClose">Close</button></div><div class="vbody" id="vBody"><p class="muted">Loading\u2026</p></div>';
    v.querySelector(".vname").textContent = d.name;
    document.body.appendChild(v);
    document.addEventListener("keydown", viewerKey);
    $("vClose").onclick = closeViewer;
    $("vDl").onclick = function () { downloadDoc(d); };
    $("vClose").focus();
    var body = $("vBody");
    function fail() { if (tok === viewTok) body.innerHTML = '<p class="muted">This file could not be displayed. Use Download instead.</p>'; }
    if (ext === "pdf") {
      if (!window.pdfjsLib) return fail();
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      fetch(url).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (buf) {
        return window.pdfjsLib.getDocument({ data: buf }).promise;
      }).then(function (pdf) {
        if (tok !== viewTok) return;
        body.innerHTML = "";
        var width = Math.min(body.clientWidth - 24, 1000), dpr = window.devicePixelRatio || 1;
        var chain = Promise.resolve();
        for (var n = 1; n <= pdf.numPages; n++) (function (n) {
          chain = chain.then(function () {
            if (tok !== viewTok) return;
            return pdf.getPage(n).then(function (page) {
              var base = page.getViewport({ scale: 1 }), scale = width / base.width;
              var vp = page.getViewport({ scale: scale * dpr });
              var cv = document.createElement("canvas");
              cv.width = vp.width; cv.height = vp.height;
              cv.style.width = (vp.width / dpr) + "px"; cv.style.height = (vp.height / dpr) + "px";
              cv.className = "vpage"; body.appendChild(cv);
              return page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
            });
          });
        })(n);
        return chain;
      }).catch(fail);
    } else if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) {
      var im = new Image(); im.alt = d.name; im.className = "vimg";
      im.onload = function () { if (tok === viewTok) { body.innerHTML = ""; body.appendChild(im); } };
      im.onerror = fail; im.src = url;
    } else if (/^(mp4|webm)$/.test(ext)) {
      body.innerHTML = '<video class="vimg" controls src="' + esc(url) + '"></video>';
    } else if (!/^(txt|md|csv|json)$/.test(ext)) {
      body.innerHTML = '<p class="muted">No preview for this file type. Use Download.</p>';
    } else {
      fetch(url).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (t) {
        if (tok !== viewTok) return;
        var pre = document.createElement("pre"); pre.className = "vtext"; pre.textContent = t;
        body.innerHTML = ""; body.appendChild(pre);
      }).catch(fail);
    }
  }

  // Fields that must be filled in before a new case can be created.
  var REQUIRED_FIELDS = [
    ["f_pnr", "PNR"], ["f_saleId", "Sale ID"], ["f_source", "Source"], ["f_orderRef", "Transaction ref"], ["f_transactionDate", "Transaction date"],
    ["f_caseNo", "Case number"], ["f_disputeDate", "Date disputed"], ["f_dueDate", "Respond by"],
    ["f_network", "Card network"], ["f_reason", "Reason"], ["f_amount", "Disputed amount"]
  ];

  function openDialog(id) {
    var c = id ? state.cases.filter(function (x) { return x.id === id; })[0] : null;
    var isNew = !c;
    c = c || { caseNo: nextCaseNo(), customer: "", orderRef: "", network: "Visa", reason: DEFAULT_VISA_REASON, pnr: "", product: "Ticket Cost", travelFrom: "", travelTo: "", amount: "", fee: "", feesCharged: false, disputeDate: todayStr(), dueDate: "", stage: "first", status: "pending", notes: "", history: [], transactionDate: "", evidence: {}, docs: [] };
    var ro = !state.canWrite;
    var dis = ro ? " disabled" : "";
    $("detailBody").innerHTML =
      '<div class="case-head"><h3 id="dlgTitle">' + (isNew ? "Add case" : "Case " + esc(c.caseNo)) + "</h3>" +
        (!isNew && (c.customer || c.pnr || c.saleId) ? '<span class="muted">' + [c.customer ? esc(c.customer) : "", c.pnr ? "PNR " + esc(c.pnr) : "", c.saleId ? "Sale " + crmLink(c.saleId) : ""].filter(Boolean).join(" \u00b7 ") + "</span>" : "") + "</div>" +
      '<div class="case-layout">' +
      '<div class="dlg">' +
        '<section class="sec"><h4>Booking</h4><div class="grid g3">' +
          '<label class="f">PNR<input id="f_pnr" class="pnr-in" maxlength="12" autocapitalize="characters" autocomplete="off" value="' + esc(c.pnr) + '"' + dis + "></label>" +
          '<label class="f">Sale ID<input id="f_saleId" inputmode="numeric" autocomplete="off" placeholder="12345" value="' + esc(c.saleId) + '"' + dis + '><span class="hint" id="saleHint"></span></label>' +
          '<label class="f">Product<select id="f_product"' + dis + '><option value="">Not set</option>' + productOpts(c.product) + "</select></label>" +
          '<label class="f">Source<select id="f_source"' + dis + '><option value="">Select source</option>' + opts(SOURCES, c.source) + "</select></label>" +
          '<label class="f">Travel start<input id="f_travelFrom" type="date" value="' + esc(c.travelFrom) + '"' + dis + "></label>" +
          '<label class="f">Travel end<input id="f_travelTo" type="date" value="' + esc(c.travelTo) + '"' + dis + '><span class="hint">Return date, if any.</span></label>' +
          '<label class="f">Order or transaction ref<input id="f_orderRef" value="' + esc(c.orderRef) + '"' + dis + '><span class="hint" id="refHint"></span></label>' +
          '<label class="f">Transaction date<input id="f_transactionDate" type="date" value="' + esc(c.transactionDate) + '"' + dis + '><span class="hint" id="txHint"></span></label>' +
        "</div></section>" +
        '<section class="sec"><h4>Dispute</h4><div class="grid g3">' +
          '<label class="f">Case number<input id="f_caseNo" value="' + esc(c.caseNo) + '"' + dis + "></label>" +
          '<label class="f">Date disputed<input id="f_disputeDate" type="date" value="' + esc(c.disputeDate) + '"' + dis + "></label>" +
          '<label class="f">Respond by<input id="f_dueDate" type="date" value="' + esc(c.dueDate) + '"' + dis + '><span class="hint" id="dueHint">Deadline for our next decision.</span></label>' +
          '<label class="f">Card network<select id="f_network"' + dis + ">" + opts(NETWORKS, c.network) + "</select></label>" +
          '<label class="f">Reason<select id="f_reason"' + dis + ">" + reasonOptions(c.network, c.reason) + '</select><span class="hint" id="reasonHint"></span></label>' +
          '<label class="f">Disputed amount<input id="f_amount" type="number" step="0.01" min="0" inputmode="decimal" value="' + esc(c.amount) + '"' + dis + "></label>" +
          '<label class="f">Dispute fees<input id="f_fee" type="number" step="0.01" min="0" inputmode="decimal" value="' + esc(c.fee) + '"' + dis + '></label>' +
          '<label class="chk span2 chk-end"><input id="f_feesCharged" type="checkbox"' + (c.feesCharged ? " checked" : "") + dis + '> Dispute fees were charged to us</label>' +
        "</div></section>" +
        '<section class="sec" id="evSec"' + (c.network === "Amex" ? "" : " hidden") + '><h4>Evidence for the Amex response <span class="muted" id="evCount"></span></h4><div class="evlist">' +
          AMEX_EVIDENCE.map(function (e) {
            return '<label class="chk"><input type="checkbox" id="f_ev_' + e[0] + '"' + (c.evidence && c.evidence[e[0]] ? " checked" : "") + dis + "> " + esc(e[1]) + "</label>";
          }).join("") + '<span class="hint">Which documents apply depends on the reason code. Send them within the 20-day window.</span></div></section>' +
        '<section class="sec" id="docSec"><h4>Documents <span class="muted" id="docCount"></span></h4>' +
          (ro ? "" : '<div class="docadd">' +
            '<input type="file" id="f_docFile" multiple hidden>' +
            '<button class="btn" type="button" id="docBtn">Upload files</button></div>') +
          '<ul class="doclist" id="docList"></ul><span class="hint" id="docHint"></span></section>' +
        '<section class="sec"><h4>Notes</h4><label class="f"><span class="sr">Notes</span><textarea id="f_notes"' + dis + ">" + esc(c.notes) + "</textarea></label></section>" +
        '<div class="err" id="dlgErr" role="alert"></div>' +
        '<div class="dlg-actions">' +
          (!isNew && !ro ? '<button class="btn danger" id="delBtn">Delete case</button>' : "") +
          '<span class="spacer"></span>' +
          '<button class="btn" id="cancelBtn">' + (ro ? "Close" : "Cancel") + "</button>" +
          (!ro ? '<button class="btn primary" id="saveBtn">' + (isNew ? "Add case" : "Save changes") + "</button>" : "") +
        "</div>" +
      "</div>" +
      '<aside class="side">' +
        '<div class="dlg"><section class="sec nobd"><h4>Stage and status</h4><div class="grid">' +
          '<label class="f full">Stage<select id="f_stage"' + dis + ">" + stageOpts(c.stage, c.network) + "</select></label>" +
          '<label class="f full">Status<select id="f_status"' + dis + ">" + statusOpts(c.stage, c.status) + "</select></label>" +
          '<label class="f full">Date of this update<input id="f_stepDate" type="date" value="' + todayStr() + '"' + dis + '><span class="hint">Used in the history when the stage or status changes.</span></label>' +
          '<p class="explain full" id="explainLive"></p>' +
          '<p class="explain full" id="decisionLive" hidden></p>' +
          (!isNew && needsStatusCheck(c) ? '<div class="explain full" id="checkLive"><strong>Time to check this case.</strong> We replied on ' + esc(fmtDate(respondedOn(c))) + ', ' + (-daysUntil(respondedOn(c))) + ' days ago. Check its status with the card network.' + (ro ? "" : '<br><button class="btn" id="checkedBtn" type="button" style="margin-top:8px">Checked, still waiting</button>') + "</div>" : "") +
        "</div></section></div>" +
        (isNew ? "" : '<div class="dlg">' + historyHtml(c) + "</div>") +
      "</aside></div>";

    var dlg = { close: closeDetail };
    function fail(m) { $("dlgErr").textContent = m; }

    function autoFees() {
      if ($("f_stage").value === "arb" && $("f_status").value === "lost") $("f_feesCharged").checked = true;
    }
    function refreshExplain() {
      var tmp = { network: $("f_network").value, stage: $("f_stage").value, status: $("f_status").value, amount: $("f_amount").value, fee: $("f_fee").value, feesCharged: $("f_feesCharged").checked };
      $("explainLive").textContent = num(tmp.amount) > 0 ? explain(tmp) : "";
      refreshDecision();
    }
    $("f_stage").onchange = function () {
      $("f_status").innerHTML = statusOpts($("f_stage").value, $("f_status").value);
      autoFees(); refreshExplain();
    };
    $("f_status").onchange = function () { autoFees(); refreshExplain(); };
    // Amex gives 20 days from the notice; suggest that deadline unless the user typed their own.
    var lastAuto = (c.network === "Amex" && c.disputeDate && c.dueDate === dstr(addDays(parseDate(c.disputeDate), 20))) ? c.dueDate : "";
    function suggestDue() {
      if ($("f_network").value !== "Amex") return;
      var dd = $("f_disputeDate").value; if (!dd) return;
      var cur = $("f_dueDate").value;
      if (cur === "" || cur === lastAuto) { lastAuto = dstr(addDays(parseDate(dd), 20)); $("f_dueDate").value = lastAuto; }
    }
    function refreshDueHint() {
      $("dueHint").textContent = $("f_network").value === "Amex" ? "Amex allows 20 days from the notice." : "Deadline for our next decision.";
    }
    // For Amex, show what to submit for the selected reason code.
    function refreshReasonHint() {
      var el = $("reasonHint"); el.textContent = "";
      if ($("f_network").value !== "Amex") return;
      var it = amexReasonInfo($("f_reason").value.split(" ")[0]);
      if (it) el.textContent = it[3] ? it[2] : "Evidence to submit: " + it[2];
    }
    $("f_reason").onchange = refreshReasonHint;
    // Amex usually decides 6 to 8 weeks after our response.
    function refreshDecision() {
      var el = $("decisionLive"); el.hidden = true;
      if ($("f_network").value !== "Amex" || $("f_status").value !== "defended") return;
      var at = "";
      if (isNew || $("f_status").value !== c.status) at = $("f_stepDate").value;
      else (c.history || []).forEach(function (h) { if (h.status === "defended" && h.at > at) at = h.at; });
      if (!at) return;
      el.textContent = "Amex usually decides 6 to 8 weeks after our response: between " + fmtShort(dstr(addDays(parseDate(at), 42))) + " and " + fmtDate(dstr(addDays(parseDate(at), 56))) + ".";
      el.hidden = false;
    }
    // Cardmembers normally have 120 days from the transaction to dispute it.
    function refreshTx() {
      var el = $("txHint"), tx = $("f_transactionDate").value, dd = $("f_disputeDate").value;
      el.className = "hint"; el.textContent = "";
      if ($("f_network").value !== "Amex" || !tx || !dd) return;
      var days = Math.round((parseDate(dd) - parseDate(tx)) / 86400000);
      if (days < 0) { el.textContent = "The dispute date is before the transaction date."; el.className = "hint warn"; }
      else if (days > 120) { el.textContent = "Filed " + days + " days after the transaction. Amex's usual window is 120 days (exceptions: non-delivery, future-dated services, cancellations), so this may be contestable."; el.className = "hint warn"; }
      else el.textContent = "Filed " + days + " days after the transaction, within Amex's usual 120-day window.";
    }
    // Amex normally allows a cardmember at most 2 disputes per charge.
    function refreshRef() {
      var el = $("refHint"), ref = $("f_orderRef").value.trim().toLowerCase();
      el.className = "hint"; el.textContent = "";
      if ($("f_network").value !== "Amex" || !ref) return;
      var others = state.cases.filter(function (x) { return x.id !== c.id && x.network === "Amex" && (x.orderRef || "").trim().toLowerCase() === ref; }).length;
      if (others >= 2) { el.textContent = "Amex normally allows at most 2 disputes per charge, and " + others + " other Amex cases use this reference."; el.className = "hint warn"; }
    }
    function refreshEvidence() {
      var n = AMEX_EVIDENCE.filter(function (e) { return $("f_ev_" + e[0]).checked; }).length;
      $("evCount").textContent = n + " of " + AMEX_EVIDENCE.length + " ready";
    }
    function refreshAmexBits() {
      $("evSec").hidden = $("f_network").value !== "Amex";
      refreshTx(); refreshRef(); refreshEvidence();
    }
    AMEX_EVIDENCE.forEach(function (e) { $("f_ev_" + e[0]).onchange = refreshEvidence; });
    $("f_transactionDate").onchange = refreshTx;
    function refreshSale() {
      var id = $("f_saleId").value.trim();
      $("saleHint").innerHTML = id ? crmLink(id).replace(">" + esc(id) + "<", ">Open in CRM<") : "From the internal CRM.";
    }
    $("f_saleId").oninput = refreshSale;
    refreshSale();
    $("f_orderRef").oninput = refreshRef;
    $("f_stepDate").onchange = refreshDecision;
    $("f_network").onchange = function () {
      var net = $("f_network").value;
      // A reason code from another network does not apply here: fall back to this network's default.
      var rv = $("f_reason").value;
      if (reasonOptions(net, "").indexOf('value="' + esc(rv) + '"') < 0) rv = net === "Visa" ? DEFAULT_VISA_REASON : net === "Amex" ? DEFAULT_AMEX_REASON : "";
      $("f_reason").innerHTML = reasonOptions(net, rv);
      refreshReasonHint();
      var st = $("f_stage").value;
      if (stagesFor(net).indexOf(st) < 0) st = "first";
      $("f_stage").innerHTML = stageOpts(st, net);
      $("f_status").innerHTML = statusOpts(st, $("f_status").value);
      suggestDue(); refreshDueHint(); refreshAmexBits(); autoFees(); refreshExplain();
    };
    $("f_disputeDate").onchange = function () { suggestDue(); refreshTx(); };
    refreshDueHint(); refreshAmexBits(); refreshReasonHint();
    $("f_amount").oninput = refreshExplain;
    $("f_fee").oninput = refreshExplain;
    $("f_feesCharged").onchange = refreshExplain;
    refreshExplain();

    /* documents */
    var docs = (c.docs || []).slice(), addedIds = [], removedIds = [];
    function dropAsset(id) { if (state.assets) state.assets.delete(id).catch(function () {}); }
    function renderDocs() {
      $("docCount").textContent = docs.length ? "(" + docs.length + ")" : "";
      $("docList").innerHTML = docs.length ? docs.map(function (d, i) {
        return '<li><div class="dname"><button type="button" class="linkbtn" data-view="' + i + '" title="View">' + esc(d.name) + '</button>' +
          '<span class="muted">' + esc(fmtSize(d.size) + " \u00b7 " + fmtDate(d.at)) + '</span></div>' +
          '<div class="dact"><button class="btn" type="button" data-view="' + i + '">View</button><button class="btn" type="button" data-dl="' + i + '">Download</button>' +
          (ro ? "" : '<button class="btn danger" type="button" data-rm="' + i + '">Remove</button>') + "</div></li>";
      }).join("") : '<li class="muted">No documents yet.</li>';
      Array.prototype.forEach.call($("docList").querySelectorAll("[data-rm]"), function (b) {
        b.onclick = function () {
          var d = docs.splice(+b.getAttribute("data-rm"), 1)[0];
          var k = addedIds.indexOf(d.id);
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
      if ($("docBtn")) {
        $("docHint").textContent = state.assets !== false ? "Any file type, up to 50 MB each."
          : "Document storage is not available in this view. Only people who can edit the published page can upload.";
      }
    }
    if ($("docBtn")) {
      $("docBtn").onclick = function () {
        var go = function () { $("f_docFile").click(); };
        if (state.assets) return go();
        if (!(window.claude && window.claude.use)) { state.assets = false; renderDocs(); toast("Document storage works only in the published page."); return; }
        window.claude.use("assets").then(function (a) {
          if (a) { state.assets = a; go(); }
          else { state.assets = false; renderDocs(); toast("Document storage is not available for you in this view."); }
        }, function () { toast("Document storage is not available."); });
      };
      $("f_docFile").onchange = function () {
        var files = Array.prototype.slice.call(this.files); this.value = "";
        var chain = Promise.resolve();
        files.forEach(function (f) {
          chain = chain.then(function () {
            return state.assets.upload(f, { type: f.type || "application/octet-stream" }).then(function (r) {
              addedIds.push(r.id);
              docs.push({ id: r.id, name: f.name, size: r.sizeBytes, type: r.contentType, at: todayStr() });
              renderDocs();
            }, function (e) { toast(f.name + " " + (DOC_ERR[e && e.code] || "could not be uploaded") + "."); });
          });
        });
      };
    }
    renderDocs();

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
      var stage = $("f_stage").value, status = $("f_status").value;
      var stepDate = $("f_stepDate").value || todayStr();
      var history = (c.history || []).slice();
      var label = stageLabel(stage, $("f_network").value) + ": " + statusLabel(status);
      if (isNew) {
        history.push({ at: $("f_disputeDate").value, stage: "first", status: "pending", text: $("f_network").value === "Amex" ? "Dispute received." : "Dispute received. Amount debited." });
        if (stage !== "first" || status !== "pending") history.push({ at: stepDate, stage: stage, status: status, text: "Case entered as " + label + "." });
      } else if (stage !== c.stage || status !== c.status) {
        history.push({ at: stepDate, stage: stage, status: status, text: label + "." });
      }
      return {
        id: c.id || uid(),
        caseNo: $("f_caseNo").value.trim() || c.caseNo,
        customer: c.customer || "",
        pnr: $("f_pnr").value.trim().toUpperCase(),
        saleId: $("f_saleId").value.trim(),
        product: $("f_product").value,
        source: $("f_source").value,
        travelFrom: $("f_travelFrom").value,
        travelTo: $("f_travelTo").value,
        orderRef: $("f_orderRef").value.trim(),
        transactionDate: $("f_transactionDate").value,
        evidence: AMEX_EVIDENCE.reduce(function (o, e) { if ($("f_ev_" + e[0]).checked) o[e[0]] = true; return o; }, {}),
        network: $("f_network").value,
        reason: $("f_reason").value,
        amount: num($("f_amount").value),
        fee: num($("f_fee").value),
        feesCharged: $("f_feesCharged").checked || (stage === "arb" && status === "lost"),
        disputeDate: $("f_disputeDate").value,
        dueDate: $("f_dueDate").value,
        stage: stage,
        status: status,
        notes: $("f_notes").value.trim(),
        history: history,
        docs: docs.slice(),
        createdAt: c.createdAt || Date.now(),
        checkedAt: c.checkedAt || ""
      };
    }

    REQUIRED_FIELDS.forEach(function (r) {
      var el = $(r[0]);
      var clear = function () { el.classList.remove("invalid"); if (!document.querySelector(".invalid")) fail(""); };
      el.addEventListener("input", clear); el.addEventListener("change", clear);
    });
    $("cancelBtn").onclick = function () { addedIds.forEach(dropAsset); dlg.close(); };
    if ($("saveBtn")) $("saveBtn").onclick = function () {
      var rec = collect(); if (!rec) return;
      $("saveBtn").disabled = true;
      saveCase(rec).then(function () {
        removedIds.forEach(dropAsset); addedIds = [];
        var outside = !inPeriod(rec);
        if (outside) { state.period = "all"; savePrefs(); }
        dlg.close();
        toast((isNew ? "Case added" : "Changes saved") + (outside ? ". Showing all time." : ""));
      }, function () { $("saveBtn").disabled = false; });
    };
    if ($("delBtn")) $("delBtn").onclick = function () {
      if (!$("delBtn").dataset.sure) {
        $("delBtn").dataset.sure = "1"; $("delBtn").textContent = "Click again to delete"; return;
      }
      removeCase(c.id).then(function () { (c.docs || []).concat(docs).forEach(function (d) { dropAsset(d.id); }); dlg.close(); toast("Case deleted"); }, function () {});
    };
    if ($("checkedBtn")) $("checkedBtn").onclick = function () {
      var rec = norm(c);
      rec.checkedAt = todayStr();
      rec.history = (rec.history || []).concat([{ at: todayStr(), text: "Status checked, still waiting." }]);
      $("checkedBtn").disabled = true;
      saveCase(rec).then(function () {
        c = rec;
        $("checkLive").hidden = true;
        toast("Marked as checked. We will remind you again in " + FOLLOW_UP_DAYS + " days.");
      }, function () { $("checkedBtn").disabled = false; });
    };
    state.openId = isNew ? "new" : c.id;
  }

  /* ---------- views (list <-> case page), driven by the URL hash ---------- */
  var listScroll = 0;
  function showView(name) {
    var detail = name === "detail";
    if (detail && $("detailView").hidden) listScroll = window.scrollY || 0;
    $("listView").hidden = detail;
    $("detailView").hidden = !detail;
    if (detail) window.scrollTo(0, 0);
    else if (listScroll) { var y = listScroll; listScroll = 0; window.scrollTo(0, y); }
    document.title = detail ? "Case - Chargeback Tracker" : "Chargeback Tracker";
  }
  function closeDetail() { if (location.hash) location.hash = ""; else route(); }
  function route() {
    var h = location.hash;
    if (h.indexOf("#case/") === 0) {
      var id = decodeURIComponent(h.slice(6));
      var exists = state.cases.some(function (x) { return x.id === id; });
      if (exists) {
        if (state.openId !== id) openDialog(id);
        showView("detail");
        return;
      }
    } else if (h === "#new" && state.canWrite) {
      if (state.openId !== "new") openDialog(null);
      showView("detail");
      return;
    }
    state.openId = null;
    $("detailBody").innerHTML = "";
    showView("list");
    renderAll();
  }

  function nextCaseNo() {
    var max = 0;
    state.cases.forEach(function (c) {
      var m = /(\d+)$/.exec(c.caseNo || "");
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return "CB-" + String(max + 1).padStart(4, "0");
  }

  /* ---------- export ---------- */
  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCsv() {
    if (!state.downloads) return;
    var head = ["Case", "Disputed on", "Respond by", "Customer", "PNR", "Sale ID", "Product", "Travel start", "Travel end", "Order ref", "Transaction date", "Network", "Reason", "Amount", "Dispute fees", "Fees charged", "Stage", "Status", "Net loss", "Notes"];
    var rows = filteredCases().map(function (c) {
      return [c.caseNo, c.disputeDate, c.dueDate, c.customer, c.pnr, c.saleId, c.product, c.travelFrom, c.travelTo, c.orderRef, c.transactionDate, c.network, c.reason, c.amount, c.fee, c.feesCharged ? "yes" : "no", stageLabel(c.stage, c.network), statusLabel(c.status), netLoss(c), c.notes].map(csvCell).join(",");
    });
    var name = "chargebacks-" + state.period + (state.period === "custom" ? "-" + (state.from || "start") + "-to-" + (state.to || "now") : "") + ".csv";
    state.downloads.save({ filename: name, data: [head.join(",")].concat(rows).join("\n") })
      .then(function () {}, function () {});
  }

  /* ---------- wire up ---------- */
  function savePrefs() { lsSet(LS_PREFS, { currency: state.currency, period: state.period, from: state.from, to: state.to, sortKey: state.sortKey, sortDir: state.sortDir }); }
  var prefs = lsGet(LS_PREFS);
  if (prefs && CURRENCIES.indexOf(prefs.currency) >= 0) state.currency = prefs.currency;
  if (prefs && PERIODS.some(function (p) { return p[0] === prefs.period; })) {
    state.period = prefs.period; state.from = prefs.from || ""; state.to = prefs.to || "";
  }

  if (prefs && DEFAULT_DIR[prefs.sortKey] && (prefs.sortDir === "asc" || prefs.sortDir === "desc")) {
    state.sortKey = prefs.sortKey; state.sortDir = prefs.sortDir;
  }

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
  $("stageFilter").onchange = function (e) { state.stage = e.target.value; renderTable(); };
  $("statusFilter").onchange = function (e) { state.status = e.target.value; renderTable(); };
  $("search").oninput = function (e) { state.q = e.target.value; renderTable(); };
  $("newBtn").onclick = function () { location.hash = "#new"; };
  $("backBtn").onclick = closeDetail;
  window.addEventListener("hashchange", route);
  $("exportBtn").onclick = exportCsv;

  initStorage();
})();
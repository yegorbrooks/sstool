(function () {
  "use strict";

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
  // Amex reason codes: [code, title].
  var AMEX_REASONS = [
    { group: "Card member disputes", items: [
      ["C02", "Credit not processed"],
      ["C04", "Goods returned or refused"],
      ["C05", "Goods or services cancelled"],
      ["C08", "Goods or services not received"],
      ["C14", "Paid by other means"],
      ["C18", "No-show or CARDeposit cancelled"],
      ["C28", "Cancelled recurring billing"],
      ["C31", "Not as described"],
      ["C32", "Damaged or defective"],
      ["M10", "Vehicle rental, capital damages"],
      ["M49", "Vehicle rental, theft or loss of use"] ] },
    { group: "Fraud", items: [
      ["F10", "Missing imprint"],
      ["F14", "Missing signature"],
      ["F24", "No cardmember authorisation"],
      ["F29", "Card not present"],
      ["F30", "EMV counterfeit"],
      ["F31", "EMV lost, stolen, or not received"] ] },
    { group: "Processing errors", items: [
      ["P01", "Unassigned card number"],
      ["P03", "Credit processed as charge"],
      ["P04", "Charge processed as credit"],
      ["P05", "Incorrect charge amount"],
      ["P07", "Late submission"],
      ["P08", "Duplicate charge"],
      ["P22", "Non-matching card number"],
      ["P23", "Currency discrepancy"] ] },
    { group: "Authorization", items: [
      ["A01", "Charge exceeds authorisation"],
      ["A02", "No valid authorisation"],
      ["A08", "Authorisation approval expired"] ] },
    { group: "Chargeback programs", items: [
      ["FR2", "Fraud Full Recourse Program"],
      ["FR4", "Immediate Chargeback Program"],
      ["FR6", "Partial Immediate Chargeback Program"] ] },
    { group: "Inquiry follow-up and other", items: [
      ["R03", "Insufficient reply"],
      ["R13", "No reply"],
      ["M01", "Chargeback authorisation"] ] }
  ];
  var DEFAULT_AMEX_REASON = "F29 Card not present";
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

  var PRODUCTS = ["Ticket Cost", "Ticket Protection", "Service Fee", "Tips", "Service Fee + Ticket Protection + Tips", "Service Fee + Tips", "Service Fee + Ticket Protection", "Ticket Protection + Tips", "Full Cost"];
  var SOURCES = ["IPS", "Merlink", "Airline"];
  var CURRENCIES = ["USD", "EUR", "GBP", "MDL", "RON"];
  // Cases saved before each case had its own currency are treated as this currency.
  var LEGACY_CURRENCY = "USD";
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
    tab: "cases",
    status: "pending",
    q: "",
    currency: "USD",
    checkOnly: false,
    urgentOnly: false,
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
  // Formats an amount in the given currency (a case's own currency), or the selected one for totals.
  function money(n, cur) {
    cur = cur || state.currency;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n || 0);
    } catch (e) { return (n || 0).toFixed(2) + " " + cur; }
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
  // Inquiries (Amex RFI / retrieval) are never debited, so they carry no money in any total.
  function isInquiry(c) { return c.stage === "inquiry"; }
  function isClosedLoss(c) { return !isInquiry(c) && (c.status === "lost" || c.status === "accepted"); }
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
    if (isInquiry(c)) return 0;
    if (c.status === "defended" || (c.stage === "prearb" && c.status === "pending")) {
      return num(c.amount) + (c.stage === "arb" ? num(c.fee) : 0);
    }
    return 0;
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
    return o;
  }

  /* ---------- storage ---------- */
  var LS_PREFS = "chargebacks:prefs:v1";

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function api(method, path, body, headers) {
    var opt = { method: method, headers: headers || {} };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      if (!r.ok) { var e = new Error("Server answered " + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }
  // Saves a case. The version (_v) it was loaded with goes along, so the server refuses
  // the save (409) if someone else saved the case in the meantime.
  function saveCase(c) {
    c.updatedAt = Date.now();
    var ver = c._v != null ? String(c._v) : "new";
    return api("PUT", "/api/cases/" + encodeURIComponent(c.id), c, { "x-version": ver }).then(function (j) {
      c._v = j.v;
      var i = state.cases.findIndex(function (x) { return x.id === c.id; });
      if (i >= 0) state.cases[i] = norm(c); else state.cases.push(norm(c));
      renderAll();
    }, function (e) { if (e.status !== 409) toast("Could not save: " + e.message); throw e; });
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
      var picking = document.activeElement && document.activeElement.classList.contains("secstatus");
      if (first) { renderAll(); route(); } else if (state.openId == null && $("detailView").hidden && !picking) renderAll();
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
      var a = document.createElement("a"), u = URL.createObjectURL(new Blob([o.data], { type: o.type || "application/octet-stream" }));
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
              awaiting: 0, awaitCount: 0, atRisk: 0, reviewAmt: 0, reviewCount: 0, decided: 0, inqOpen: 0 };
    list.forEach(function (c) {
      var a = num(c.amount);
      // Win rate counts every closed case, inquiries included.
      if (c.status === "won") { s.wonCount++; s.decided++; }
      else if (c.status === "lost" || c.status === "accepted") { s.lostCount++; s.decided++; }
      // Inquiries have no financial impact: keep them out of every amount.
      if (isInquiry(c)) { if (c.status === "pending" || c.status === "defended") s.inqOpen++; return; }
      s.disputed += a;
      if (c.status === "won") s.won += a;
      else if (isClosedLoss(c)) { s.lostAmt += a; s.fees += feeIn(c); }
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
    $("newBtn").disabled = !state.canWrite;
  }

  function renderStats() {
    // Statistics only add up cases in the selected currency; cases in other currencies are counted in a note.
    var all = state.cases.filter(inPeriod);
    var inP = all.filter(function (c) { return c.currency === state.currency; });
    var s = computeStats(inP);
    var others = {};
    all.forEach(function (c) { if (c.currency !== state.currency) others[c.currency] = (others[c.currency] || 0) + 1; });
    var otherKeys = Object.keys(others).sort();
    var note = otherKeys.length
      ? '<p class="muted statnote">' + esc("Statistics include " + state.currency + " cases only. Not included: " +
          otherKeys.map(function (k) { return plural(others[k], "case", "cases") + " in " + k; }).join(", ") + ".") + "</p>"
      : "";
    var card = '<div class="statcard">' + outcomeDonut(s) +
      '<ul class="clegend olegend statextra">' +
        '<li title="' + esc("Disputes: " + money(s.lostAmt + s.awaiting) + ", Fees: " + money(s.fees)) + '"><span class="cl">Net loss, ' + esc(periodText()) + '</span><span class="cp' + (s.netLoss ? " loss" : "") + '">' + esc(money(s.netLoss)) + "</span></li>" +
        '<li><span class="cl">Credited back, still at risk</span><span class="cp wait">' + esc(money(s.atRisk)) + "</span></li>" +
        (s.inqOpen ? '<li title="Inquiries are not debited, so they are left out of all amounts."><span class="cl">Open inquiries, no debit</span><span class="cp">' + esc(plural(s.inqOpen, "case", "cases")) + "</span></li>" : "") +
      "</ul>" + note + "</div>";
    var charts = '<div class="charts">' +
      winCard(s) +
      chartCard("Dispute reasons", inP, function (c) { return c.reason; }) +
      chartCard("Products", inP, function (c) { return c.product; }) +
      trendCards(inP) +
    "</div>";

    $("statsArea").innerHTML = '<div class="stats">' + card + charts + "</div>";
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
    return svg + legend;
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
      var a = isInquiry(c) ? 0 : num(c.amount);
      total += a;
      if (i != null) { buckets[i].amt += a; buckets[i].n++; }
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

  // Follow-up after we defend: check the case 45 days after the First chargeback's
  // Respond by date, 15 days after Pre-arbitration's. Arbitration: no reminder.
  var FOLLOW_UP_DAYS = { inquiry: 45, first: 45, prearb: 15 };
  function followUpDays(c) { return FOLLOW_UP_DAYS[c.stage] || 0; }
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
  function checkFrom(c) {
    if (c.status !== "defended" || !followUpDays(c)) return "";
    return c.dueDate || respondedOn(c);
  }
  function followUpDate(c) {
    var b = checkFrom(c); if (!b) return "";
    var base = c.checkedAt && c.checkedAt > b ? c.checkedAt : b;
    return dstr(addDays(parseDate(base), followUpDays(c)));
  }
  function needsStatusCheck(c) {
    var f = followUpDate(c);
    return !!f && daysUntil(f) <= 0;
  }
  function needsDecision(c) {
    return c.status === "pending" && c.dueDate;
  }
  // Pending cases whose decision deadline has passed or is within 7 days.
  function isUrgent(c) {
    if (!needsDecision(c)) return false;
    var d = daysUntil(c.dueDate); return d !== null && d <= 7;
  }
  function showSpecial(which) {
    state.q = ""; $("search").value = "";
    location.hash = which === "urgent" ? "#urgent" : "#check";
  }
  function renderAlert() {
    var html = "";
    var urgent = state.cases.filter(isUrgent);
    if (urgent.length) {
      var late = urgent.filter(function (c) { return daysUntil(c.dueDate) < 0; }).length;
      var msg = late
        ? plural(late, "case is", "cases are") + " past the deadline for our decision" + (urgent.length > late ? ", and " + (urgent.length - late) + " more due within 7 days." : ".")
        : plural(urgent.length, "case needs", "cases need") + " our decision within 7 days.";
      html += '<div class="alert' + (late ? " hot" : "") + '"><span>' + esc(msg) + '</span><button id="showUrgent">Show them</button></div>';
    }
    var check = state.cases.filter(needsStatusCheck);
    if (check.length) {
      html += '<div class="alert"><span>' + esc(plural(check.length, "case is", "cases are") + " due for a status check.") + '</span><button id="showCheck">Show them</button></div>';
    }
    var area = $("alertArea");
    area.innerHTML = html;
    if ($("showUrgent")) $("showUrgent").onclick = function () { showSpecial("urgent"); };
    if ($("showCheck")) $("showCheck").onclick = function () { showSpecial("check"); };
  }

  // Search box and alert links: one flat list across all stages and statuses.
  function matchesFilters(c) {
    var q = state.q.trim().toLowerCase();
    // Alert lists ("Show them") show every case that needs action, whatever the period.
    if (!state.checkOnly && !state.urgentOnly && !inPeriod(c)) return false;
    if (state.checkOnly && !needsStatusCheck(c)) return false;
    if (state.urgentOnly && !isUrgent(c)) return false;
    if (q) {
      var hay = [c.caseNo, c.customer, c.pnr, c.saleId, c.product, c.orderRef, c.reason, c.network, c.notes].join(" ").toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function sortCases(list) {
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

  var DEFAULT_DIR = { amount: "desc", disputeDate: "desc", dueDate: "asc" };
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

  // Cases tab, top to bottom. Each section opens on its first status (Pending; Defended for arbitration).
  var SECTIONS = [["first", "First chargeback"], ["prearb", "Pre-arbitration"], ["inquiry", "Inquiries (RFI)"], ["arb", "Arbitration"]];

  function caseRow(c, showStage) {
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
        (needsStatusCheck(c) ? ' <span class="pill act">Check status</span>' : "") + "</td></tr>";
  }
  function caseTable(list, sec, showStage) {
    return '<div class="tablewrap"><table><thead><tr><th>PNR</th><th>Sale ID</th><th>Source</th>' +
      sortTh("amount", "Amount", "num", sec) + sortTh("disputeDate", "Disputed date", "", sec) + sortTh("dueDate", "Due date", "", sec) +
      "<th>Travel date</th>" + (showStage ? "<th>Dispute cycle</th>" : "") + "<th>Status</th></tr></thead><tbody>" +
      list.map(function (c) { return caseRow(c, showStage); }).join("") + "</tbody></table></div>";
  }

  function checkQueue() {
    var list = sortCases(state.cases.filter(needsStatusCheck));
    if (!list.length) return "";
    return '<section class="casesec checkq" aria-label="Check status"><div class="sechead"><h3>Check status <span class="muted">(' +
      list.length + ")</span></h3></div>" + caseTable(list, "check", true) + "</section>";
  }

  function renderTable() {
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
      var list = sortCases(state.cases.filter(matchesFilters));
      var title = state.urgentOnly ? "Cases needing a decision" : state.checkOnly ? "Cases to check" : "Search results, " + periodText();
      $("listTitle").innerHTML = '<button type="button" class="btn backall" id="clearSpecial">&larr; All cases</button> ' +
        esc(title + " (" + list.length + ")");
      $("clearSpecial").onclick = function () {
        state.q = ""; $("search").value = "";
        if (state.urgentOnly || state.checkOnly) location.hash = "#cases"; else renderTable();
      };
      area.innerHTML = list.length ? caseTable(list, "all", true) : '<div class="empty"><p>No cases match.</p></div>';
    } else {
      $("listTitle").textContent = "Cases, " + periodText();
      var sel = STATUSES[state.status] ? state.status : "pending";
      var inPer = state.cases.filter(inPeriod);
      var counts = {};
      STATUS_ORDER.forEach(function (k) { counts[k] = 0; });
      inPer.forEach(function (c) { if (c.status in counts) counts[c.status]++; });
      sf.innerHTML = STATUS_ORDER.map(function (k) {
        return '<option value="' + k + '"' + (k === sel ? " selected" : "") + ">" + esc(STATUSES[k].label + " (" + counts[k] + ")") + "</option>";
      }).join("");
      area.innerHTML = SECTIONS.map(function (s) {
        var key = s[0];
        var rows = sortCases(inPer.filter(function (c) { return c.stage === key && c.status === sel; }));
        var lbl = STATUSES[sel].label.toLowerCase();
        var empty = STATUS_BY_STAGE[key].indexOf(sel) < 0 ? s[1] + " has no " + lbl + " status." : "No " + lbl + " cases.";
        return '<section class="casesec" aria-label="' + esc(s[1]) + '"><div class="sechead"><h3>' + esc(s[1]) + "</h3></div>" +
          (rows.length ? caseTable(rows, key, false) : '<p class="muted secempty">' + esc(empty) + "</p>") +
          "</section>";
      }).join("");

      Array.prototype.forEach.call(area.querySelectorAll("select.secstatus"), function (sl) {
        sl.onchange = function () {
          var sec = sl.getAttribute("data-sec");
          state.secStatus[sec] = sl.value;
          renderTable();
          var again = area.querySelector('select.secstatus[data-sec="' + sec + '"]');
          if (again) again.focus();
        };
      });
    }
    Array.prototype.forEach.call(area.querySelectorAll("th button[data-sort]"), function (btn) {
      btn.onclick = function () { setSort(btn.getAttribute("data-sort"), btn.getAttribute("data-sec")); };
    });
    if (state.refocus) {
      var rb = area.querySelector('th button[data-sort="' + state.refocus.key + '"][data-sec="' + state.refocus.sec + '"]');
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
  function currencyOpts(sel) {
    var html = opts(CURRENCIES, sel);
    if (sel && CURRENCIES.indexOf(sel) < 0) html = '<option value="' + esc(sel) + '" selected>' + esc(sel) + "</option>" + html;
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

  function stageDatesHtml(c) {
    var log = c.stageLog || [];
    if (!log.length) return "";
    return '<div class="flow"><h4>Stage dates</h4><ol class="timeline">' + log.map(function (s) {
      return '<li><span class="when">' + esc(stageLabel(s.stage, c.network)) + "</span><span>Received " + esc(fmtDate(s.received) || "\u2014") +
        (s.due ? ", respond by " + esc(fmtDate(s.due)) : "") + "</span></li>";
    }).join("") + "</ol></div>";
  }

  /* ---------- document viewer ---------- */
  var viewTok = 0;
  function downloadDoc(d) {
    var a = document.createElement("a"); a.href = "/api/files/" + d.id + "?download=1"; document.body.appendChild(a); a.click(); a.remove();
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

  // The open case page registers this so leaving it can warn about unsaved changes.
  var leaveGuard = null;
  // A snapshot of every field on the case page, used to tell whether anything was changed.
  function formSnap() {
    return Array.prototype.map.call($("detailBody").querySelectorAll("input, select, textarea"), function (el) {
      if (el.type === "file") return "";
      return el.id + "=" + (el.type === "checkbox" ? el.checked : el.value);
    }).join("\n");
  }

  function openDialog(id) {
    var c = id ? state.cases.filter(function (x) { return x.id === id; })[0] : null;
    var isNew = !c;
    c = c || { caseNo: nextCaseNo(), customer: "", orderRef: "", network: "Visa", reason: DEFAULT_VISA_REASON, pnr: "", product: "Ticket Cost", travelFrom: "", travelTo: "", amount: "", currency: state.currency, fee: "", feesCharged: false, disputeDate: todayStr(), dueDate: "", stage: "first", status: "pending", notes: "", history: [], transactionDate: "", docs: [] };
    // Dates of the stage the case is in now.
    var cur = isNew ? { received: c.disputeDate, due: "" } : c.stageLog[c.stageLog.length - 1];
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
          '<span class="spacer"></span>' +
          '<button class="btn" id="cancelBtn">' + (ro ? "Close" : "Cancel") + "</button>" +
          (!ro ? '<button class="btn primary" id="saveBtn">' + (isNew ? "Add case" : "Save changes") + "</button>" : "") +
        "</div>" +
      "</div>" +
      '<aside class="side">' +
        '<div class="dlg"><section class="sec nobd"><h4>Stage and status</h4><div class="grid">' +
          '<label class="f full">Stage<select id="f_stage"' + dis + ">" + stageOpts(c.stage, c.network) + "</select></label>" +
          '<label class="f full">Status<select id="f_status"' + dis + ">" + statusOpts(c.stage, c.status) + "</select></label>" +
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

    var dlg = { close: closeDetail };
    function fail(m) { $("dlgErr").textContent = m; }

    function autoFees() {
      if ($("f_stage").value === "arb" && $("f_status").value === "lost") $("f_feesCharged").checked = true;
    }
    function recvLabel() {
      $("recvLabel").textContent = stageLabel($("f_stage").value, $("f_network").value) + " received on";
    }
    $("f_stage").onchange = function () {
      var st = $("f_stage").value;
      if (isNew) {
        $("f_status").innerHTML = statusOpts(st, $("f_status").value);
      } else if (st === c.stage) {
        // Back to the saved stage: restore its saved dates.
        $("f_status").innerHTML = statusOpts(st, c.status);
        $("f_stageReceived").value = cur.received;
        $("f_dueDate").value = c.dueDate;
      } else {
        // A new stage starts with its own dates: received today by default, and a new deadline.
        $("f_status").innerHTML = statusOpts(st, "");
        $("f_stageReceived").value = todayStr();
        $("f_dueDate").value = "";
        lastAuto = "";
        suggestDue();
      }
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
      if (reasonOptions(net, "").indexOf('value="' + esc(rv) + '"') < 0) rv = net === "Visa" ? DEFAULT_VISA_REASON : net === "Amex" ? DEFAULT_AMEX_REASON : "";
      $("f_reason").innerHTML = reasonOptions(net, rv);
      var prev = $("f_stage").value, st = prev;
      if (stagesFor(net).indexOf(st) < 0) st = "first";
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

    /* documents */
    var docs = (c.docs || []).slice(), addedIds = [], removedIds = [];
    function dropAsset(id) { if (state.assets) state.assets.delete(id).catch(function () {}); }
    function renderDocs() {
      $("docCount").textContent = docs.length ? "(" + docs.length + ")" : "";
      $("docList").innerHTML = docs.length ? docs.map(function (d, i) {
        return '<li><div class="dname"><button type="button" class="linkbtn" data-view="' + i + '" title="View">' + esc(d.name) + "</button>" +
          '<span class="muted">' + esc(fmtSize(d.size) + " \u00b7 " + fmtDate(d.at)) + "</span></div>" +
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
    }
    if ($("docBtn")) {
      $("docBtn").onclick = function () { $("f_docFile").click(); };
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
      var received = $("f_stageReceived").value, due = $("f_dueDate").value;
      var net = $("f_network").value;
      var sLabel = stageLabel(stage, net);
      if (!received) { fail("Enter the date the " + sLabel + " notice was received."); $("f_stageReceived").focus(); return null; }
      if (due && due < received) { fail("Respond by cannot be before the received date."); $("f_dueDate").focus(); return null; }
      var history = (c.history || []).slice();
      var stageLog = (c.stageLog || []).map(function (s) { return { stage: s.stage, received: s.received, due: s.due }; });
      var label = sLabel + ": " + statusLabel(status);
      if (isNew) {
        var start = stage === "inquiry" ? "inquiry" : "first";
        history.push({ at: $("f_disputeDate").value, stage: start, status: "pending",
          text: start === "inquiry" ? "Inquiry received. Nothing debited." : net === "Amex" ? "Dispute received." : "Dispute received. Amount debited." });
        if (stage !== start) history.push({ at: received, stage: stage, status: STATUS_BY_STAGE[stage][0], text: sLabel + " received" + (due ? ", respond by " + fmtDate(due) : "") + "." });
        if (status !== STATUS_BY_STAGE[stage][0]) history.push({ at: stepDate, stage: stage, status: status, text: "Case entered as " + label + "." });
        stageLog = [{ stage: stage, received: received, due: due }];
      } else if (stage !== c.stage) {
        // New stage: log its own dates; the previous stage's dates stay in the log.
        history.push({ at: received, stage: stage, status: STATUS_BY_STAGE[stage][0], text: sLabel + " received" + (due ? ", respond by " + fmtDate(due) : "") + "." });
        if (status !== STATUS_BY_STAGE[stage][0]) history.push({ at: stepDate, stage: stage, status: status, text: label + "." });
        stageLog.push({ stage: stage, received: received, due: due });
      } else {
        if (status !== c.status) history.push({ at: stepDate, stage: stage, status: status, text: label + "." });
        // Same stage, dates edited: keep the old values in the history.
        var last = stageLog[stageLog.length - 1];
        if (received !== last.received) history.push({ at: todayStr(), stage: stage, text: sLabel + " received date changed from " + (fmtDate(last.received) || "none") + " to " + fmtDate(received) + "." });
        if (due !== (c.dueDate || "")) history.push({ at: todayStr(), stage: stage, text: "Respond by changed from " + (fmtDate(c.dueDate) || "none") + " to " + (fmtDate(due) || "none") + "." });
        last.received = received; last.due = due;
      }
      return {
        id: c.id || uid(),
        _v: c._v,
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
        network: $("f_network").value,
        reason: $("f_reason").value,
        amount: num($("f_amount").value),
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
    }

    // Someone else saved this case after we opened it: our save was refused, nothing was overwritten.
    function showConflict() {
      $("dlgErr").innerHTML = esc("Someone else saved this case after you opened it, so your changes were not saved. " +
        "Copy anything you need from the form, then load their version" + (addedIds.length ? " (files you uploaded here will need to be uploaded again)" : "") + ". ") +
        '<button type="button" class="linkbtn" id="reloadCase">Load their version</button>';
      $("reloadCase").onclick = function () {
        if (leaveGuard) leaveGuard.discard();
        leaveGuard = null;
        loadCases(false).then(function () { state.openId = null; route(); });
      };
    }

    REQUIRED_FIELDS.forEach(function (r) {
      var el = $(r[0]);
      var clear = function () { el.classList.remove("invalid"); if (!document.querySelector(".invalid")) fail(""); };
      el.addEventListener("input", clear); el.addEventListener("change", clear);
    });
    $("cancelBtn").onclick = function () {
      // Cancel is an explicit "discard", so no extra question.
      if (leaveGuard) leaveGuard.discard();
      leaveGuard = null;
      dlg.close();
    };
    if ($("saveBtn")) $("saveBtn").onclick = function () {
      var rec = collect(); if (!rec) return;
      $("saveBtn").disabled = true;
      saveCase(rec).then(function () {
        removedIds.forEach(dropAsset); addedIds = [];
        leaveGuard = null;
        var outside = !inPeriod(rec);
        if (outside) { state.period = "all"; savePrefs(); }
        dlg.close();
        toast((isNew ? "Case added" : "Changes saved") + (outside ? ". Showing all time." : ""));
      }, function (e) {
        $("saveBtn").disabled = false;
        if (e && e.status === 409) showConflict();
      });
    };
    if ($("delBtn")) $("delBtn").onclick = function () {
      if (!$("delBtn").dataset.sure) {
        $("delBtn").dataset.sure = "1"; $("delBtn").textContent = "Click again to delete"; return;
      }
      removeCase(c.id).then(function () {
        (c.docs || []).concat(docs).forEach(function (d) { dropAsset(d.id); });
        leaveGuard = null;
        dlg.close(); toast("Case deleted");
      }, function () {});
    };
    if ($("checkedBtn")) $("checkedBtn").onclick = function () {
      var rec = norm(c);
      rec.checkedAt = todayStr();
      rec.history = (rec.history || []).concat([{ at: todayStr(), text: "Status checked, still waiting." }]);
      $("checkedBtn").disabled = true;
      saveCase(rec).then(function () {
        c = rec;
        $("checkLive").hidden = true;
        toast("Marked as checked.");
      }, function (e) {
        $("checkedBtn").disabled = false;
        if (e && e.status === 409) showConflict();
      });
    };

    // Remember how the form looked when opened, so leaving can warn about unsaved changes.
    var snap0 = formSnap();
    leaveGuard = {
      isDirty: function () { return !ro && (addedIds.length > 0 || removedIds.length > 0 || formSnap() !== snap0); },
      discard: function () { addedIds.forEach(dropAsset); addedIds = []; }
    };
    state.openId = isNew ? "new" : c.id;
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
    if (state.openId && state.openId !== target && leaveGuard) {
      if (leaveGuard.isDirty() && !window.confirm("You have unsaved changes on this case. Leave without saving?")) {
        location.hash = state.openId === "new" ? "#new" : "#case/" + encodeURIComponent(state.openId);
        return;
      }
      leaveGuard.discard();   // files uploaded but never saved to the case are removed again
      leaveGuard = null;
    }
    if (target) {
      if (state.openId !== target) openDialog(target === "new" ? null : target);
      showView("detail");
      return;
    }
    state.openId = null;
    $("detailBody").innerHTML = "";
    state.urgentOnly = h === "#urgent";
    state.checkOnly = h === "#check";
    state.listHash = h;
    showTab(h === "#stats" ? "stats" : h === "#tools" ? "tools" : "cases");
    showView("list");
    renderAll();
  }
  // Closing or reloading the tab with unsaved changes: the browser shows its own warning.
  window.addEventListener("beforeunload", function (e) {
    if (leaveGuard && leaveGuard.isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

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
    // Text starting with = + - @ would run as a formula in Excel; a leading ' keeps it as plain text.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
    v = v == null ? "" : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCsv() {
    if (!state.downloads) return;
    var head = ["Case", "Disputed on", "Respond by", "Customer", "PNR", "Sale ID", "Source", "Product", "Travel start", "Travel end", "Order ref", "Transaction date", "Network", "Reason", "Amount", "Currency", "Dispute fees", "Fees charged", "Stage", "Status", "Net loss", "Notes"];
    var rows = sortCases(state.cases.filter(inPeriod)).map(function (c) {
      return [c.caseNo, c.disputeDate, c.dueDate, c.customer, c.pnr, c.saleId, c.source, c.product, c.travelFrom, c.travelTo, c.orderRef, c.transactionDate, c.network, c.reason, c.amount, c.currency, c.fee, c.feesCharged ? "yes" : "no", stageLabel(c.stage, c.network), statusLabel(c.status), netLoss(c), c.notes].map(csvCell).join(",");
    });
    var name = "chargebacks-" + state.period + (state.period === "custom" ? "-" + (state.from || "start") + "-to-" + (state.to || "now") : "") + ".csv";
    // The leading \uFEFF tells Excel the file is UTF-8, so accents and Cyrillic show correctly.
    state.downloads.save({ filename: name, type: "text/csv;charset=utf-8", data: "\uFEFF" + [head.join(",")].concat(rows).join("\r\n") })
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

  initStorage();
})();
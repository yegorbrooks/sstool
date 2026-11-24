// Stats tab: numbers card, win rate, reason and product donuts, trend charts.
import { state } from "./state.js";
import { $, esc, money, num, plural, parseDate, dstr, addDays, fmtDate, fmtShort, todayStr } from "./util.js";
import { isInquiry, isClosedLoss, isAwaitingDebit, feeIn, atRisk } from "./model.js";
import { inPeriod, periodRange, periodText } from "./period.js";

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

export function renderStats() {
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

  // Stage moves are dated by when the new stage arrived, not the dispute date,
  // so they use every case in this currency and filter by period themselves.
  var cur = state.cases.filter(function (c) { return c.currency === state.currency; });
  var charts = '<div class="charts">' +
    winCard(s) +
    chartCard("Dispute reasons", inP, function (c) { return c.reason; }) +
    chartCard("Products", inP, function (c) { return c.product; }) +
    movesCard(cur) +
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

/* ---------- stage moves ---------- */
var MOVES = [
  ["inquiry", "first", "Inquiry \u2192 Chargeback", "inquiries"],
  ["first", "prearb", "Chargeback \u2192 Pre-arb", "chargebacks"],
  ["prearb", "arb", "Pre-arb \u2192 Arbitration", "pre-arbs"]
];
// The stages a case went through, each dated by when its notice arrived.
function stagePath(c) {
  var path = (c.stageLog || []).map(function (s) {
    return { stage: s.stage, at: s.received || "", amount: s.amount != null && s.amount !== "" ? num(s.amount) : num(c.amount) };
  });
  // A case added straight at a later stage: its starting stage is only in the history.
  var h0 = (c.history || [])[0];
  if (h0 && h0.stage && path.length && h0.stage !== path[0].stage) {
    path.unshift({ stage: h0.stage, at: h0.at || "", amount: path[0].amount });
  }
  return path;
}
function inRange(d) {
  var r = periodRange();
  if (!d) return !r.from && !r.to;
  if (r.from && d < r.from) return false;
  if (r.to && d > r.to) return false;
  return true;
}
function movesCard(list) {
  var rows = MOVES.map(function (m) { return { from: m[0], to: m[1], label: m[2], noun: m[3], n: 0, amt: 0, base: 0, on: 0 }; });
  list.forEach(function (c) {
    var p = stagePath(c);
    p.forEach(function (s, i) {
      rows.forEach(function (r) {
        // Reached the earlier stage in this period: did it move on later?
        if (s.stage === r.from && inRange(s.at)) { r.base++; if (i < p.length - 1) r.on++; }
        // Moved into this stage in this period.
        if (i > 0 && s.stage === r.to && inRange(s.at)) { r.n++; r.amt += s.amount; }
      });
    });
  });
  return '<div class="chartcard movecard"><h3>Moved to next stage, ' + esc(periodText()) + '</h3><div class="moves">' +
    rows.map(function (r) {
      var pct = r.base ? Math.round(r.on / r.base * 100) : null;
      return '<div class="move"><div class="mv-label">' + esc(r.label) + "</div>" +
        '<div class="mv-n">' + r.n + "</div>" +
        '<div class="mv-amt">' + esc(money(r.amt)) + "</div>" +
        (pct === null ? "" : '<div class="muted mv-rate" title="' +
          esc(r.on + " of " + r.base + " " + r.noun + " received " + periodText() + " moved to the next stage") + '">' +
          pct + "% of " + esc(r.noun) + " moved on</div>") +
      "</div>";
    }).join("") + "</div></div>";
}

function winCard(s) {
  if (!s.decided) return emptyCard("Win rate", "No closed cases yet.");
  var segs = [{ label: "Won", n: s.wonCount, color: "var(--win)" }];
  if (s.lostCount) segs.push({ label: "Lost or accepted", n: s.lostCount, color: "var(--loss)" });
  return donutCard("Win rate", segs, s.decided, Math.round(s.winRate * 100) + "%", "win rate");
}

/* ---------- trend charts ---------- */
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

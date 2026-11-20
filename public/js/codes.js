// Fixed lists: card networks, reason codes, products, sources and currencies.
import { esc, opts } from "./util.js";

export var REASONS = ["Fraud", "Product not received", "Not as described", "Duplicate charge", "Subscription canceled", "Credit not processed", "Other"];
export var NETWORKS = ["Visa", "Mastercard", "Amex", "Other"];
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
var MC_REASONS = [
  { group: "Fraud", items: [
    ["4837", "No cardholder authorization"],
    ["4837", "First-party trust (Consumer Clarity)"],
    ["4870", "Chip liability shift"],
    ["4871", "Chip lost, stolen or never received"] ] },
  { group: "Authorization (4808)", items: [
    ["4808", "Required authorization not obtained"],
    ["4808", "Chargeback protection period expired"],
    ["4808", "Stand-in or X-Code approval after decline"],
    ["4808", "CAT 3 device"],
    ["4808", "Transit first ride risk"] ] },
  { group: "Cardholder dispute (4853)", items: [
    ["4853", "Not as described or defective"],
    ["4853", "Goods or services not provided"],
    ["4853", "Travel services not provided, voucher issued"],
    ["4853", "Failed travel merchant (Europe)"],
    ["4853", "Digital goods, 25 USD/EUR or less"],
    ["4853", "Refund not processed"],
    ["4853", "Counterfeit goods"],
    ["4853", "Recurring transaction, cardholder dispute"],
    ["4853", "Recurring transaction, issuer dispute"],
    ["4853", "Addendum dispute"],
    ["4853", "Hotel no-show charge"],
    ["4853", "Transaction did not complete"],
    ["4853", "Timeshare"],
    ["4853", "Refund posted as a purchase"] ] },
  { group: "Other cardholder disputes", items: [
    ["4850", "Installment billing not as agreed"],
    ["4854", "Not elsewhere classified (US only)"] ] },
  { group: "Point-of-interaction error (4834)", items: [
    ["4834", "Debited twice or paid by other means"],
    ["4834", "Transaction amount differs"],
    ["4834", "Cash back not provided"],
    ["4834", "ATM funds not dispensed"],
    ["4834", "Charges for loss, theft or damage"],
    ["4834", "Currency error or DCC"],
    ["4834", "Refund caused exchange loss"],
    ["4834", "Improper surcharge"],
    ["4834", "Unreasonable amount (EEA/UK)"],
    ["4834", "Late presentment"] ] },
  { group: "Questionable merchant (4849)", items: [
    ["4849", "Questionable merchant audit (QMAP)"],
    ["4849", "Coercion program"] ] }
];
var DEFAULT_MC_REASON = "4837 No cardholder authorization";
var DEFAULT_AMEX_REASON = "F29 Card not present";
export var DEFAULT_VISA_REASON = "10.4 Other Fraud - Card-Absent Environment";

// Visa, Mastercard and Amex use their own reason codes; other networks keep the general list.
export function defaultReason(network) {
  return network === "Visa" ? DEFAULT_VISA_REASON : network === "Mastercard" ? DEFAULT_MC_REASON : network === "Amex" ? DEFAULT_AMEX_REASON : "";
}
export function reasonOptions(network, sel) {
  var html, values = [];
  var groups = network === "Visa" ? VISA_REASONS : network === "Mastercard" ? MC_REASONS : network === "Amex" ? AMEX_REASONS : null;
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

export var PRODUCTS = ["Ticket Cost", "Ticket Protection", "Service Fee", "Tips", "Service Fee + Ticket Protection + Tips", "Service Fee + Tips", "Service Fee + Ticket Protection", "Ticket Protection + Tips", "Full Cost"];
export var SOURCES = ["IPS", "Merlink", "Airline"];
export var CURRENCIES = ["USD", "EUR", "GBP", "MDL", "RON"];
// Cases saved before each case had its own currency are treated as this currency.
export var LEGACY_CURRENCY = "USD";

export function productOpts(sel) {
  var html = opts(PRODUCTS, sel);
  if (sel && PRODUCTS.indexOf(sel) < 0) html = '<option value="' + esc(sel) + '" selected>' + esc(sel) + "</option>" + html;
  return html;
}
export function currencyOpts(sel) {
  var html = opts(CURRENCIES, sel);
  if (sel && CURRENCIES.indexOf(sel) < 0) html = '<option value="' + esc(sel) + '" selected>' + esc(sel) + "</option>" + html;
  return html;
}

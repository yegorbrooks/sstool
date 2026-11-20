// Shared app state. Every module reads and writes this one object.
export var state = {
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
  loaded: false,
  expired: false,
  sig: "",
  me: "",
  openId: null,
  closeModal: null,
  listHash: "",
  refocus: null,
  // The open case page registers this so leaving it can warn about unsaved changes.
  leaveGuard: null,
  // Goes up every time a case page opens or closes, so work that finishes late (an upload)
  // can tell whether the page it started on is still the one on screen.
  pageTok: 0
};

// Page-level actions that main.js fills in at startup. Lower modules call these
// (for example, a save redraws the page) without importing main.js themselves.
export var app = {
  renderAll: function () {},
  renderAlert: function () {},
  route: function () {},
  closeDetail: function () {}
};

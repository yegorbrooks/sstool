// Shared helpers for the API handlers.
export const MAX_FILE = 50 * 1024 * 1024;

export const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

/* ---------- Cloudflare Access: verify the signed login token ---------- */
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = (s) => JSON.parse(new TextDecoder().decode(b64(s)));

// Returns the signed-in user's email, or null if the request is not from an allowed Access login.
async function accessUser(req, env) {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const [h, p, s] = token.split(".");
    const header = parse(h), claims = parse(p);
    if (header.alg !== "RS256") return null;
    const jwks = await (await fetch(env.TEAM_DOMAIN + "/cdn-cgi/access/certs", { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(s), new TextEncoder().encode(h + "." + p));
    const aud = [].concat(claims.aud);
    const email = String(claims.email || "").toLowerCase();
    const now = Date.now() / 1000;
    if (!ok) return null;
    if (claims.iss !== env.TEAM_DOMAIN) return null;
    if (!aud.includes(env.POLICY_AUD)) return null;
    if (!(claims.exp > now)) return null;
    if (claims.nbf && claims.nbf > now + 60) return null;
    if (!email.endsWith(String(env.ALLOWED_DOMAIN || "").toLowerCase())) return null;
    return email;
  } catch (e) {
    return null;
  }
}

// Every API call needs a valid @flyluxury.com login. Returns the user's email, or null.
// Local development only: DEV=1 in .dev.vars skips the check, and only when running on localhost,
// so a stray DEV variable in production can never switch sign-in off.
export async function requestUser(req, env) {
  const host = new URL(req.url).hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  if (env.DEV === "1" && local) return env.DEV_USER || "dev@localhost";
  return accessUser(req, env);
}

import type { AxiosResponse } from "axios";
import { client, uniformHeaders } from "./oauth.js";
import { ingestSetCookie, loadSession, saveSession, type Session } from "./cookies.js";
import { getJwt } from "./index.js";
import type { Credentials } from "./login.js";

/**
 * Migusto (migusto.migros.ch) doesn't use the www.migros.ch JWT. It keeps its
 * own server-side session (JSESSIONID), established by an OIDC prompt=none
 * round-trip against login.migros.ch — so the same SSO cookies we already
 * hold for the JWT flow are enough to log in silently.
 */
export const MIGUSTO = "https://migusto.migros.ch";
const MIGUSTO_HOST = "migusto.migros.ch";

/**
 * Follow /service/mkp/oidc/checkImmediate -> login.migros.ch/oauth2/authorize
 * -> /service/mkp/oidc/immediate?code=... and collect cookies along the way.
 * Mutates `session`. Throws if login.migros.ch answers with an error
 * (typically `login_required` when the SSO cookies have expired).
 */
async function migustoLogin(session: Session): Promise<void> {
  let url = `${MIGUSTO}/service/mkp/oidc/checkImmediate`;
  for (let hop = 0; hop < 8; hop++) {
    const host = new URL(url).host;
    const r = await client().get(url, {
      headers: uniformHeaders(host, session, { Accept: "text/html" }),
    });
    ingestSetCookie(session, host, r.headers["set-cookie"]);
    const location: string | undefined = r.headers.location;
    if (!location) return;
    const next = new URL(location, url);
    const error = next.searchParams.get("error");
    if (error) throw new Error(`Migusto silent login failed: ${error}`);
    url = next.toString();
  }
  throw new Error("Migusto silent login: too many redirects");
}

function isAuthorized(r: AxiosResponse): boolean {
  if (r.status < 200 || r.status >= 300) return false;
  // Cookbook endpoints wrap errors as {status: 401, ...} with a 400 HTTP code,
  // but guard against a 200 wrapper too.
  const body = typeof r.data === "string" ? null : (r.data as { status?: number } | null);
  return !(body && typeof body.status === "number" && body.status === 401);
}

async function makeRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  session: Session
): Promise<AxiosResponse> {
  const r = await client().request({
    method,
    url: `${MIGUSTO}${path}`,
    data: body,
    headers: uniformHeaders(MIGUSTO_HOST, session, {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    }),
  });
  ingestSetCookie(session, MIGUSTO_HOST, r.headers["set-cookie"]);
  return r;
}

/**
 * Authenticated request against a migusto.migros.ch path. Reuses the cached
 * Migusto session; if rejected, re-runs the silent OIDC login and retries.
 * If the SSO cookies themselves are stale, refreshes them via getJwt (which
 * falls back to a full credentialed login) and tries once more.
 */
export async function migustoApi(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { creds?: Credentials } = {}
): Promise<unknown> {
  let session = loadSession();
  let r = await makeRequest(method, path, body, session);

  if (!isAuthorized(r)) {
    // Drop the stale Migusto session so the OIDC flow starts clean.
    delete session.cookies[MIGUSTO_HOST];
    try {
      await migustoLogin(session);
    } catch {
      // SSO cookies expired: let the main auth layer re-login, then retry.
      saveSession(session);
      await getJwt(opts.creds);
      session = loadSession();
      delete session.cookies[MIGUSTO_HOST];
      await migustoLogin(session);
    }
    r = await makeRequest(method, path, body, session);
  }
  saveSession(session);

  if (!isAuthorized(r)) {
    const snippet = typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200);
    throw new Error(`${method} ${path} -> ${r.status}: ${snippet}`);
  }
  if (r.data === "" || r.data === undefined) return null;
  return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
}

/**
 * Resolve a numeric Migusto recipe id to its slug via the /{lang}/r/{id}
 * short-link redirect. Returns null if the recipe doesn't exist (404).
 */
export async function resolveRecipeSlug(id: string, language: string): Promise<string | null> {
  const r = await client().get(`${MIGUSTO}/${language}/r/${encodeURIComponent(id)}`, {
    headers: uniformHeaders(MIGUSTO_HOST, { cookies: {}, jwt: null, jwtExp: 0 }),
  });
  const location: string | undefined = r.headers.location;
  if (!location) return null;
  const slug = new URL(location, MIGUSTO).pathname.split("/").filter(Boolean).pop();
  return slug ?? null;
}

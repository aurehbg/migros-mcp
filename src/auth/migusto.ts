import type { AxiosResponse } from "axios";
import { client, uniformHeaders } from "./oauth.js";
import { ingestSetCookie, loadSession, saveSession, type Session } from "./cookies.js";
import { getJwt } from "./index.js";
import type { Credentials } from "./login.js";
import { MIGUSTO } from "../migusto.js";

/**
 * Migusto (migusto.migros.ch) is a Next.js app with its own server-side
 * session (`next_js_session`), established by an OIDC prompt=none round-trip
 * against login.migros.ch — so the SSO cookies we already hold for the
 * www.migros.ch JWT flow are enough to log in silently.
 *
 * There is no REST API: bookmarks and cookbooks are read and written through
 * Next.js server actions; page parsing lives in ../migusto.ts.
 */
const MIGUSTO_HOST = "migusto.migros.ch";
const LOGIN_PATH = "/api/auth/login?mode=auto";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function get(url: string, session: Session, accept: string): Promise<AxiosResponse> {
  const host = new URL(url).host;
  const r = await client().get(url, {
    headers: uniformHeaders(host, session, { Accept: accept }),
    transformResponse: (x) => x,
  });
  ingestSetCookie(session, host, r.headers["set-cookie"]);
  return r;
}

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

/**
 * Server action ids are content hashes that change on every Migusto deploy,
 * so we discover them by name from the client bundles and cache per process.
 */
let actionIds: Record<string, string> | null = null;

async function discoverActionIds(): Promise<Record<string, string>> {
  const anon: Session = { cookies: {}, jwt: null, jwtExp: 0 };
  const chunks = new Set<string>();
  for (const page of ["/de", "/de/sammlung"]) {
    const r = await get(`${MIGUSTO}${page}`, anon, "text/html");
    for (const m of String(r.data).matchAll(/\/_next\/static\/chunks\/[\w.-]+\.js/g)) chunks.add(m[0]);
  }
  const ids: Record<string, string> = {};
  const list = [...chunks];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const r = await get(`${MIGUSTO}${list[next++]}`, anon, "*/*");
      if (r.status !== 200) continue;
      const re = /createServerReference\)\("([0-9a-f]{16,})",[^"]*"(\w+)"\)/g;
      for (const m of String(r.data).matchAll(re)) ids[m[2]] = m[1];
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return ids;
}

async function actionId(name: string, refresh = false): Promise<string> {
  if (!actionIds || refresh) actionIds = await discoverActionIds();
  const id = actionIds[name];
  if (!id) throw new Error(`Migusto server action "${name}" not found — the site may have changed.`);
  return id;
}

/** Parse a React Server Components (text/x-component) action response. */
function parseActionResult(text: string): unknown {
  const rows = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):(.*)$/.exec(line);
    if (m && !rows.has(m[1])) rows.set(m[1], m[2]);
  }
  const root = rows.get("0");
  if (!root) throw new Error("Migusto action: malformed response");
  const ref = (JSON.parse(root) as { a?: string }).a;
  if (typeof ref !== "string" || !ref.startsWith("$@")) return undefined;
  const row = rows.get(ref.slice(2));
  return row === undefined ? undefined : JSON.parse(row);
}

/** Actions report auth failures as {error: {status: 401, ...}} or {error: "401"}. */
function isUnauthorized(v: unknown): boolean {
  const err = (v as { error?: unknown } | null)?.error;
  if (err === 401 || err === "401") return true;
  const e = err as { status?: number; messageCode?: string } | null | undefined;
  return !!e && typeof e === "object" && (e.status === 401 || e.messageCode === "UNAUTHORIZED");
}

/** POST one server action with `session`'s cookies; rediscovers ids on 404. */
async function callAction(session: Session, name: string, args: unknown[]): Promise<unknown> {
  const post = async (id: string) => {
    const r = await client().post(`${MIGUSTO}/de`, JSON.stringify(args), {
      headers: uniformHeaders(MIGUSTO_HOST, session, {
        Accept: "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "Next-Action": id,
      }),
      transformResponse: (x) => x,
    });
    ingestSetCookie(session, MIGUSTO_HOST, r.headers["set-cookie"]);
    return r;
  };
  let r = await post(await actionId(name));
  if (r.status === 404) r = await post(await actionId(name, true));
  if (r.status !== 200) throw new Error(`Migusto ${name} -> ${r.status}: ${String(r.data).slice(0, 200)}`);
  return parseActionResult(String(r.data));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Probe the login state. The login endpoint can't be used for this (it
 * answers 204 whenever a `migusto_auto_login_blocked` cookie is present,
 * regardless of the session), and serverActionFetchBookmarks returns an empty
 * list instead of 401 when logged out — but the cookbooks action does 401.
 */
async function isLoggedIn(session: Session): Promise<boolean> {
  return !isUnauthorized(await callAction(session, "severActionFetchCookbooks", []));
}

/**
 * /api/auth/login?mode=auto -> {redirectUrl} -> login.migros.ch/oauth2/authorize
 * (prompt=none) -> /api/auth/callback/migros-login -> app. Mutates `session`.
 * Throws if login.migros.ch reports an error (typically `login_required` when
 * the SSO cookies have expired).
 *
 * Starts from an empty Migusto cookie jar: a leftover
 * `migusto_auto_login_blocked` cookie would make the server skip the flow.
 */
async function migustoLogin(session: Session): Promise<void> {
  delete session.cookies[MIGUSTO_HOST];
  const r = await get(`${MIGUSTO}${LOGIN_PATH}`, session, "application/json");
  let body: { redirectUrl?: string; error?: unknown } = {};
  try {
    body = JSON.parse(String(r.data));
  } catch {
    throw new Error(`Migusto login: unexpected response ${r.status}`);
  }
  if (body.error || !body.redirectUrl) {
    throw new Error(`Migusto login failed: ${JSON.stringify(body.error ?? "no redirectUrl")}`);
  }

  let url: string | undefined = body.redirectUrl;
  for (let hop = 0; url && hop < 8; hop++) {
    const current: URL = new URL(url, MIGUSTO);
    const error = current.searchParams.get("error");
    if (error) throw new Error(`Migusto silent login failed: ${error}`);
    const res = await get(current.toString(), session, "text/html");
    url = res.headers.location ? new URL(res.headers.location, current).toString() : undefined;
    // Once the callback has redirected back into the app, we're done.
    if (current.pathname.startsWith("/api/auth/callback/")) {
      const err = url ? new URL(url).searchParams.get("error") : null;
      if (err) throw new Error(`Migusto silent login failed: ${err}`);
      return;
    }
  }
  throw new Error("Migusto silent login: did not reach the auth callback");
}

/**
 * Load the cached session and make sure it carries a valid Migusto login.
 * If the SSO cookies themselves are stale, refreshes them via getJwt (which
 * falls back to a full credentialed login) and tries once more.
 */
async function ensureSession(creds?: Credentials, force = false): Promise<Session> {
  let session = loadSession();
  if (!force && session.cookies[MIGUSTO_HOST]?.next_js_session && (await isLoggedIn(session))) {
    return session;
  }
  try {
    await migustoLogin(session);
    if (!(await isLoggedIn(session))) throw new Error("not logged in after silent login");
  } catch {
    saveSession(session);
    await getJwt(creds);
    session = loadSession();
    await migustoLogin(session);
    if (!(await isLoggedIn(session))) throw new Error("Migusto login did not produce a valid session");
  }
  saveSession(session);
  return session;
}

/**
 * Invoke a Migusto server action by name on a logged-in session, re-logging
 * in once if the action still answers 401.
 */
export async function migustoAction<T>(
  name: string,
  args: unknown[],
  opts: { creds?: Credentials } = {}
): Promise<T> {
  let session = await ensureSession(opts.creds);
  let value = await callAction(session, name, args);
  if (isUnauthorized(value)) {
    session = await ensureSession(opts.creds, true);
    value = await callAction(session, name, args);
  }
  saveSession(session);
  if (isUnauthorized(value)) throw new Error(`Migusto ${name}: not authorized`);
  return value as T;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** GET a logged-in Migusto page and return its HTML. */
export async function migustoPage(path: string, opts: { creds?: Credentials } = {}): Promise<string> {
  let session = await ensureSession(opts.creds);
  let r = await get(`${MIGUSTO}${path}`, session, "text/html");
  if (!/"isLoggedIn\\?":true/.test(String(r.data))) {
    session = await ensureSession(opts.creds, true);
    r = await get(`${MIGUSTO}${path}`, session, "text/html");
  }
  saveSession(session);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status}`);
  return String(r.data);
}

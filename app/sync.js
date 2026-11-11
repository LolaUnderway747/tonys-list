/* sync.js — background sync between the local store and Supabase (plain fetch, no SDK, so it works from the service-worker cache).
 *
 * Model: one table `docs(user_id, path, data, ts, deleted, seq)`. Each cycle is
 *   1. PUSH every dirty local record through the push_docs() RPC. The server keeps a row only if our ts is newer (last-write-wins).
 *   2. PULL every row with seq > our saved cursor, and merge it locally (newer ts wins; our unsynced newer edit survives).
 * Deletes travel as tombstones (deleted = true). Nothing here ever blocks the UI; offline simply means "try again later".
 *
 * Needs config.js: window.TL_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY }. Empty = local-only mode.
 */
(() => {
"use strict";

const CFG = window.TL_CONFIG || {};
const enabled = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

let db = null;                 // the LocalDB `_x` internals
let session = null;            // { access, refresh, exp (unix s), email }
let running = false, again = false, timer = null, retry401 = 0;
const st = { state: enabled ? "signedout" : "local", pending: 0, email: null, error: null };
const listeners = new Set();
const emit = () => listeners.forEach(f => { try { f({ ...st }); } catch (_) {} });
const setState = p => { Object.assign(st, p); emit(); };

const base = () => CFG.SUPABASE_URL.replace(/\/+$/, "");
// Only send an Authorization header when we hold a real user token. Works with both the legacy anon JWT key
// and the newer sb_publishable_ keys (those are not JWTs and must not be sent as a Bearer token).
const hdr = tok => { const h = { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" }; if (tok) h.Authorization = "Bearer " + tok; return h; };
const isNet = e => !!e && (e.name === "AbortError" || e instanceof TypeError);   // fetch failures = no connection

async function http(url, opts, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
async function httpErr(r) {
  const j = await r.json().catch(() => ({}));
  const e = new Error(j.message || j.error_description || j.msg || j.hint || ("HTTP " + r.status));
  e.status = r.status;
  return e;
}

/* ---------- auth (Supabase GoTrue, email + password) ---------- */
async function authCall(grant, body) {
  const r = await http(`${base()}/auth/v1/token?grant_type=${grant}`, { method: "POST", headers: hdr(), body: JSON.stringify(body) });
  if (!r.ok) throw await httpErr(r);
  return r.json();
}
const toSession = j => ({
  access: j.access_token, refresh: j.refresh_token,
  exp: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
  email: (j.user && j.user.email) || (session && session.email) || ""
});
async function saveSession(s) { session = s; await db.setMeta("session", s); }

async function token() {
  if (!session) return null;
  if (session.exp - 60 > Date.now() / 1000) return session.access;
  try {
    await saveSession(toSession(await authCall("refresh_token", { refresh_token: session.refresh })));
    return session.access;
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 403) {   // refresh token dead: need a new sign-in
      await saveSession(null);
      setState({ state: "signedout", email: null });
      return null;
    }
    throw e;
  }
}

async function signIn(email, password) {
  const j = await authCall("password", { email, password });
  await saveSession(toSession(j));
  setState({ state: "idle", email: session.email, error: null });
  trigger(0);
}
async function signOut() {
  await saveSession(null);
  setState({ state: "signedout", email: null });
}

/* ---------- the sync cycle ---------- */
async function run() {
  if (!enabled || !session || !db) return;
  if (running) { again = true; return; }
  running = true;
  try {
    if (!navigator.onLine) { setState({ state: "offline" }); return; }
    setState({ state: "syncing", error: null });
    const tok = await token();
    if (!tok) return;

    // 1. push
    const dirty = db.dirty();
    for (let i = 0; i < dirty.length; i += 100) {
      const chunk = dirty.slice(i, i + 100);
      const r = await http(`${base()}/rest/v1/rpc/push_docs`, { method: "POST", headers: hdr(tok), body: JSON.stringify({ items: chunk }) });
      if (!r.ok) throw await httpErr(r);
      for (const d of chunk) await db.markClean(d.path, d.ts);
    }

    // 2. pull
    let cursor = (await db.getMeta("cursor")) || 0;
    for (;;) {
      const r = await http(`${base()}/rest/v1/docs?select=path,data,ts,deleted,seq&seq=gt.${cursor}&order=seq.asc&limit=500`, { headers: hdr(tok) });
      if (!r.ok) throw await httpErr(r);
      const rows = await r.json();
      for (const row of rows) await db.applyRemote(row);
      if (rows.length) { cursor = rows[rows.length - 1].seq; await db.setMeta("cursor", cursor); }
      if (rows.length < 500) break;
    }
    await db.setMeta("lastSync", Date.now());
    retry401 = 0;
    setState({ state: "synced", error: null });
  } catch (e) {
    if (isNet(e)) setState({ state: "offline" });
    else if (e.status === 401 && retry401++ < 1) { if (session) session.exp = 0; again = true; }   // stale token: refresh once and retry
    else setState({ state: "error", error: String(e.message || e) });
  } finally {
    running = false;
    setState({ pending: db.dirty().length });
    if (again) { again = false; trigger(500); }
  }
}
function trigger(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }

async function start(localdb) {
  db = localdb;
  setState({ pending: db.dirty().length });
  if (!enabled) { setState({ state: "local" }); return; }
  session = (await db.getMeta("session")) || null;
  setState({ state: session ? "idle" : "signedout", email: session ? session.email : null });
  db.onChange(() => { setState({ pending: db.dirty().length }); trigger(1500); });   // push shortly after each edit
  addEventListener("online", () => trigger(200));
  addEventListener("offline", () => setState({ state: "offline" }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") trigger(300); });
  setInterval(() => { if (document.visibilityState === "visible") trigger(0); }, 60000);
  trigger(0);
}

window.Sync = {
  enabled, start, signIn, signOut,
  syncNow: () => run(),
  snapshot: () => ({ ...st }),
  onStatus(f) { listeners.add(f); f({ ...st }); }
};
})();

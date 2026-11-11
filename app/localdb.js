/* localdb.js — local-first document store on IndexedDB.
 *
 * Mimics the small slice of the claude.ai `db` API the UI already uses, so the UI code barely changes:
 *   db.collection("tasks").onSnapshot(cb, errCb)     db.doc("meta/brief").onSnapshot(cb, errCb)
 *   db.doc("tasks/ID").set(obj) | .update(patch) | .delete()
 *
 * Every stored record is { path, data, ts, deleted, dirty }:
 *   ts       ms timestamp of the last edit (local edit, or the remote edit we accepted). Last-write-wins key.
 *   deleted  tombstone. A delete must be *synced*, so we keep a marker instead of removing the record.
 *   dirty    true = changed on this device and not yet confirmed by the server. The sync module pushes these.
 *
 * All reads are served from an in-memory Map loaded at open(); writes update the Map synchronously
 * (UI is instant, works offline) and persist to IndexedDB right behind it.
 */
(() => {
"use strict";

const DB_NAME = "tonyslist", DOCS = "docs", META = "meta";
const clone = o => JSON.parse(JSON.stringify(o));
const txDone = tx => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error("IndexedDB transaction aborted"));
});
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore(DOCS, { keyPath: "path" });
      d.createObjectStore(META, { keyPath: "k" });   // sync cursor, session, etc.
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("IndexedDB blocked"));
  });
}

async function open() {
  const idb = await openIDB();
  const all = await reqP(idb.transaction(DOCS).objectStore(DOCS).getAll());
  const cache = new Map(all.map(r => [r.path, r]));

  const subs = new Set();          // active snapshot listeners
  const changeHooks = new Set();   // called after every LOCAL write (sync uses this to schedule a push)
  const touched = new Set();
  let flushQueued = false;

  /* ---- listener plumbing: batch notifications into one microtask ---- */
  function schedule(path) {
    touched.add(path);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      const paths = [...touched]; touched.clear();
      for (const s of [...subs]) if (paths.some(s.match)) s.fire();
    });
  }
  function subscribe(match, snap, cb, err) {
    const s = { match, fire() { try { cb(snap()); } catch (e) { console.error(e); if (err) try { err(e); } catch (_) {} } } };
    subs.add(s);
    queueMicrotask(() => s.fire());     // initial snapshot, like the hosted db
    return () => subs.delete(s);
  }

  const inColl = (name, p) => p.startsWith(name + "/") && !p.slice(name.length + 1).includes("/");
  const collSnap = name => {
    const docs = [];
    for (const r of cache.values()) {
      if (r.deleted || !inColl(name, r.path)) continue;
      docs.push({ id: r.path.slice(name.length + 1), data: () => clone(r.data) });
    }
    return { docs };
  };
  const docSnap = path => {
    const r = cache.get(path), ok = !!r && !r.deleted;
    return { exists: ok, id: path.split("/").pop(), data: () => (ok ? clone(r.data) : undefined) };
  };

  /* ---- persistence ---- */
  async function persist(rec) {
    const tx = idb.transaction(DOCS, "readwrite");
    tx.objectStore(DOCS).put(rec);
    await txDone(tx);
  }

  /* ---- local writes: instant in memory, durable a moment later ---- */
  function writeLocal(path, data, deleted) {
    const old = cache.get(path);
    // strictly increasing per doc, even if the clock hiccups, so a later edit always beats an earlier one
    const ts = Math.max(Date.now(), (old ? old.ts : 0) + 1);
    const rec = { path, data: deleted ? {} : clone(data), ts, deleted: !!deleted, dirty: true };
    cache.set(path, rec);
    schedule(path);
    changeHooks.forEach(f => { try { f(); } catch (_) {} });
    return persist(rec);
  }

  const api = {
    collection(name) {
      return { onSnapshot: (cb, err) => subscribe(p => inColl(name, p), () => collSnap(name), cb, err) };
    },
    doc(path) {
      return {
        set: data => writeLocal(path, data, false),
        update: patch => {
          const old = cache.get(path);
          const base = old && !old.deleted ? clone(old.data) : {};
          return writeLocal(path, { ...base, ...clone(patch) }, false);
        },
        delete: () => {
          const old = cache.get(path);
          return old && !old.deleted ? writeLocal(path, {}, true) : Promise.resolve();
        },
        onSnapshot: (cb, err) => subscribe(p => p === path, () => docSnap(path), cb, err)
      };
    },
    exists: path => { const r = cache.get(path); return !!r && !r.deleted; }
  };

  /* ---- internals used by sync.js and the backup/import screen ---- */
  api._x = {
    dirty: () => [...cache.values()].filter(r => r.dirty).map(r => ({ path: r.path, data: r.data, ts: r.ts, deleted: r.deleted })),

    // Server accepted our copy. Only clear dirty if nothing newer was written while the request was in flight.
    async markClean(path, ts) {
      const r = cache.get(path);
      if (r && r.dirty && r.ts === ts) { r.dirty = false; await persist(r); }
    },

    // Merge one row from the server. Newer timestamp wins; our own unsynced edit wins a tie-break only if newer.
    async applyRemote(row) {
      const local = cache.get(row.path);
      const take = !local || row.ts > local.ts || (row.ts === local.ts && !local.dirty);
      if (!take) return false;
      const rec = { path: row.path, data: row.deleted ? {} : (row.data || {}), ts: row.ts, deleted: !!row.deleted, dirty: false };
      cache.set(row.path, rec);
      schedule(row.path);
      await persist(rec);
      return true;
    },

    async getMeta(k) { const r = await reqP(idb.transaction(META).objectStore(META).get(k)); return r ? r.v : undefined; },
    async setMeta(k, v) { const tx = idb.transaction(META, "readwrite"); tx.objectStore(META).put({ k, v }); await txDone(tx); },
    onChange(f) { changeHooks.add(f); return () => changeHooks.delete(f); },

    exportAll() {
      return {
        app: "tonys-list", version: 1, exportedAt: new Date().toISOString(),
        docs: [...cache.values()].filter(r => !r.deleted).map(r => ({ path: r.path, data: clone(r.data) }))
      };
    }
  };

  return api;
}

window.LocalDB = { open };
})();

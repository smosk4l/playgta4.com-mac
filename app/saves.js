// Keeps the engine's save directory durable across reloads, browsers and origins:
//   - IndexedDB 'LibertyRecompSaves' (per origin; persistent storage is requested so it is not evicted),
//   - mirrored to the local server's saves/ folder (runtime/server.js, /saves/* endpoints),
//   - export/import to a single JSON file from the F9 / Option+S panel (or window.exportSaves()/importSaves()).
// Only files the game finished writing are stored: a write-mode stream must be closed (or fsync'd)
// before its file is snapshotted, so a half-written save never replaces the last good copy.
'use strict';

(function () {
    const append = (line) => LibertyBoot.log(line, false);
    const warn = (line) => LibertyBoot.log(line, true);

    const SAVE_ROOT = '/data/LibertyRecomp/saves';
    const DB_NAME = 'LibertyRecompSaves';
    const STORE_NAME = 'saves';
    const SERVER = 'saves/'; // saves/index (listing), saves/file/<relPath> (GET/PUT/DELETE)
    const SCAN_INTERVAL_MS = 30000;
    const SERVER_TIMEOUT_MS = 10000;
    const MAX_FILE_BYTES = 32 << 20;
    const MAX_IMPORT_FILES = 1000;
    const EXPORT_FORMAT = 'liberty-saves';
    const FILE_MODE = 0o100666;

    // ── State ────────────────────────────────────────────────────────────────
    const known = new Map();      // relPath -> { isDir, mtime, size } as last stored in IndexedDB
    const dirty = new Set();      // relPaths changed in the FS since they were last stored
    const writers = new Map();    // relPath -> Set of open write-stream trackers
    const serverJobs = new Map(); // relPath -> { op: 'put', rec } | { op: 'delete' } waiting for the mirror
    const serverKnown = new Map(); // relPath -> mtime of the copy in the server's saves/ folder
    let server = 'unknown';       // 'unknown' | 'off' (no endpoint) | 'ok' | 'error'
    let serverError = '';
    let idbError = '';
    let storagePersisted = null;
    let restoreDone = false;
    let restorePromise = null;
    let suppressHooks = false;
    let gameWrote = false;
    let unloading = false;

    // ── Paths ────────────────────────────────────────────────────────────────
    function relOf(p) {
      if (typeof p !== 'string' || !p) return null;
      if (!p.startsWith('/')) p = FS.cwd() + '/' + p;
      if (typeof PATH !== 'undefined') p = PATH.normalize(p);
      if (p === SAVE_ROOT) return '';
      return p.startsWith(SAVE_ROOT + '/') ? p.slice(SAVE_ROOT.length + 1) : null;
    }
    const fullOf = (rel) => SAVE_ROOT + '/' + rel;
    const toMs = (t) => (t && typeof t.getTime === 'function' ? t.getTime() : typeof t === 'number' ? t : Date.now());
    const under = (key, rel) => key === rel || key.startsWith(rel + '/');

    // Accepts only plain relative paths (no '..', no absolute, no hidden or control-character segments).
    // The server applies the same rule.
    function cleanRelPath(p) {
      if (typeof p !== 'string' || !p || p.length > 512 || p.startsWith('/') || /[\\\0]/.test(p)) return null;
      const parts = p.split('/');
      if (parts.length > 8) return null;
      for (const seg of parts) {
        if (!seg || seg.startsWith('.') || seg.length > 128 || /[\x00-\x1f:*?"<>|]/.test(seg)) return null;
      }
      return p;
    }

    function statRel(rel) {
      try {
        return FS.stat(fullOf(rel));
      } catch (e) {
        return null;
      }
    }

    // Calls visit(relPath, stat) for every entry below rel ('' = the save root).
    function walk(rel, visit) {
      let entries;
      try {
        entries = FS.readdir(rel ? fullOf(rel) : SAVE_ROOT);
      } catch (e) {
        return;
      }
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        const child = rel ? rel + '/' + name : name;
        const st = statRel(child);
        if (!st) continue;
        visit(child, st);
        if (FS.isDir(st.mode)) walk(child, visit);
      }
    }

    // A file is consistent when nobody has it open for writing, or every writer fsync'd after its last write.
    function consistent(rel) {
      const set = writers.get(rel);
      if (!set || !set.size) return true;
      for (const t of set) if (!t.synced) return false;
      return true;
    }

    // ── IndexedDB (one cached connection) ────────────────────────────────────
    let dbPromise = null;
    function openSaveDB() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
          return reject(e);
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'relPath' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          db.onclose = () => { dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = () => warn('[saves] IndexedDB open is blocked by another tab');
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }

    // Runs fn(store) in one transaction; resolves with the result of the request fn returns, after commit.
    async function idbRun(mode, fn, retried) {
      const db = await openSaveDB();
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode, { durability: 'strict' });
      } catch (e) {
        // The cached connection was closed underneath us: reopen once.
        dbPromise = null;
        if (!retried) return idbRun(mode, fn, true);
        throw e;
      }
      return new Promise((resolve, reject) => {
        let result;
        const req = fn(tx.objectStore(STORE_NAME));
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    }

    // ── Server mirror ────────────────────────────────────────────────────────
    const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

    async function serverFetch(url, options = {}) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), SERVER_TIMEOUT_MS);
      try {
        return await fetch(url, { cache: 'no-store', ...options, signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    // Map of relPath -> { size, mtime } from the server, or null when there is no mirror endpoint.
    async function fetchServerIndex() {
      try {
        const res = await serverFetch(SERVER + 'index');
        if (!res.ok || !/json/.test(res.headers.get('content-type') || '')) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        const map = new Map();
        for (const f of body.files || []) {
          if (cleanRelPath(f.path) && f.size <= MAX_FILE_BYTES) map.set(f.path, { size: f.size, mtime: Math.round(f.mtimeMs) });
        }
        server = 'ok';
        return map;
      } catch (e) {
        server = 'off';
        append('[saves] No disk backup endpoint (' + (e.message || e) + '); saves stay in browser storage only');
        return null;
      }
    }

    let mirrorRun = null;
    let mirrorAgain = false;
    // Sends queued puts/deletes to the server. Resolves true when the queue is empty.
    function mirror() {
      if (server === 'off' || server === 'unknown') return Promise.resolve(false);
      if (mirrorRun) {
        mirrorAgain = true;
        return mirrorRun;
      }
      mirrorRun = (async () => {
        do {
          mirrorAgain = false;
          for (const [rel, job] of [...serverJobs]) {
            const url = SERVER + 'file/' + encodePath(rel);
            let res;
            try {
              if (job.op === 'put') {
                res = await serverFetch(url, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/octet-stream', 'X-Liberty-Saves': '1', 'X-Mtime': String(job.rec.mtime) },
                  body: job.rec.contents,
                  keepalive: unloading && job.rec.contents.byteLength < 60000,
                });
              } else {
                res = await serverFetch(url, { method: 'DELETE', headers: { 'X-Liberty-Saves': '1' }, keepalive: unloading });
              }
              if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 120));
            } catch (e) {
              const wasOk = server === 'ok';
              server = 'error';
              serverError = String(e.message || e);
              warn('[saves] Disk backup failed for ' + rel + ': ' + serverError);
              if (wasOk) toast('Disk backup failed (saves are still in the browser): ' + serverError, 'err');
              updatePanel();
              return false;
            }
            if (serverJobs.get(rel) === job) serverJobs.delete(rel);
            if (job.op === 'put') {
              serverKnown.set(rel, job.rec.mtime);
            } else {
              serverKnown.delete(rel);
              dropTombstone(rel);
            }
            if (server !== 'ok') {
              server = 'ok';
              serverError = '';
              toast('Disk backup reconnected', 'ok');
              updatePanel();
            }
          }
        } while (mirrorAgain);
        return serverJobs.size === 0;
      })().finally(() => { mirrorRun = null; });
      return mirrorRun;
    }

    function dropTombstone(rel) {
      idbRun('readwrite', (store) => {
        const req = store.get(rel);
        req.onsuccess = () => { if (req.result && req.result.deleted) store.delete(rel); };
      }).catch(() => {});
    }

    // ── Persist ──────────────────────────────────────────────────────────────
    function fileRecord(rel, st) {
      const contents = new Uint8Array(FS.readFile(fullOf(rel)));
      return { relPath: rel, isDir: false, mode: st.mode, mtime: toMs(st.mtime), size: contents.byteLength, contents };
    }
    const dirRecord = (rel, st) => ({ relPath: rel, isDir: true, mode: st.mode, mtime: toMs(st.mtime) });

    // One persist pass: stores every dirty path that is consistent, deletes removed ones.
    async function flushOnce() {
      if (restorePromise) await restorePromise.catch(() => {});
      if (typeof FS === 'undefined' || !dirty.size) return { stored: 0 };
      const puts = new Map();
      const dels = new Set();
      const taken = [];
      const keep = [];
      for (const rel of dirty) {
        const st = statRel(rel);
        if (!st) {
          dels.add(rel);
          for (const k of known.keys()) if (under(k, rel)) dels.add(k);
          taken.push(rel);
        } else if (FS.isDir(st.mode)) {
          puts.set(rel, dirRecord(rel, st));
          // Covers directories renamed into place: store whatever below differs from what is stored.
          walk(rel, (child, cst) => {
            const prev = known.get(child);
            if (FS.isDir(cst.mode)) {
              if (!prev) puts.set(child, dirRecord(child, cst));
            } else if (FS.isFile(cst.mode)) {
              if (!consistent(child)) keep.push(child);
              else if (!prev || prev.mtime !== toMs(cst.mtime) || prev.size !== cst.size) puts.set(child, fileRecord(child, cst));
            }
          });
          taken.push(rel);
        } else if (!FS.isFile(st.mode)) {
          taken.push(rel);
        } else if (consistent(rel)) {
          puts.set(rel, fileRecord(rel, st));
          taken.push(rel);
        }
      }
      for (const rel of taken) dirty.delete(rel);
      for (const rel of keep) dirty.add(rel);
      if (!puts.size && !dels.size) return { stored: 0 };

      const now = Date.now();
      const tombstones = [];
      for (const rel of dels) {
        if (puts.has(rel)) dels.delete(rel);
        else if ((known.has(rel) && !known.get(rel).isDir) || serverKnown.has(rel)) tombstones.push({ relPath: rel, deleted: true, mtime: now });
      }
      const wrote = gameWrote;
      gameWrote = false;
      const files = [...puts.values()].filter((r) => !r.isDir);

      for (const rec of files) serverJobs.set(rec.relPath, { op: 'put', rec });
      for (const t of tombstones) serverJobs.set(t.relPath, { op: 'delete' });

      let failure = null;
      try {
        await idbRun('readwrite', (store) => {
          for (const rel of dels) store.delete(rel);
          for (const t of tombstones) store.put(t);
          for (const rec of puts.values()) store.put(rec);
        });
        for (const rel of dels) known.delete(rel);
        for (const rec of puts.values()) known.set(rec.relPath, { isDir: rec.isDir, mtime: rec.mtime, size: rec.size });
        if (idbError) {
          idbError = '';
          updatePanel();
        }
      } catch (e) {
        failure = e;
        for (const rel of taken) dirty.add(rel);
        idbError = String((e && (e.name + ': ' + e.message)) || e);
      }

      const mirrored = mirror();
      if (failure) {
        // Browser storage failed; the save is still safe if the disk backup took it.
        const ok = await mirrored;
        warn('[saves] Browser storage write failed: ' + idbError + (ok ? ' (stored in the disk backup)' : ''));
        if (ok) {
          toast('Browser storage failed; save kept in the disk backup only', 'err');
          updatePanel();
          return { stored: files.length, degraded: true };
        }
        toast('Save NOT stored: ' + idbError, 'err');
        updatePanel();
        throw failure;
      }
      if (files.length) append('[saves] Stored ' + files.length + ' save file(s) in browser storage');
      if (wrote && files.length) toast('Saved ✓', 'ok');
      return { stored: files.length };
    }

    // Serialised: callers get a promise that settles after their changes were stored (or failed).
    let tail = Promise.resolve();
    let pendingRun = null;
    let inFlight = 0;
    function persist() {
      if (pendingRun) return pendingRun;
      const run = tail.then(() => {
        pendingRun = null;
        inFlight++;
        return flushOnce().finally(() => { inFlight--; });
      });
      pendingRun = run;
      tail = run.catch(() => {});
      return run;
    }

    let timer = null;
    function schedule(delayMs) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        persist().catch(() => {});
      }, delayMs);
    }

    function markDirty(rel) {
      if (suppressHooks || rel === null || rel === '' || rel === undefined) return;
      dirty.add(rel);
    }

    // Catches changes the hooks did not see (e.g. a stream written without close). Reads only stat().
    function scanForChanges() {
      if (!restoreDone) return;
      walk('', (rel, st) => {
        const prev = known.get(rel);
        if (FS.isDir(st.mode)) {
          if (!prev) dirty.add(rel);
        } else if (FS.isFile(st.mode) && consistent(rel) &&
          (!prev || prev.mtime !== toMs(st.mtime) || prev.size !== st.size)) {
          dirty.add(rel);
        }
      });
    }

    // ── Restore ──────────────────────────────────────────────────────────────
    // Merges IndexedDB and the server's saves/ folder per file (newest mtime wins; a deletion recorded in
    // IndexedDB beats an older server copy), then writes the result into the FS before main() runs.
    async function restore() {
      let records = [];
      try {
        records = (await idbRun('readonly', (store) => store.getAll())) || [];
      } catch (e) {
        idbError = String((e && (e.name + ': ' + e.message)) || e);
        warn('[saves] Cannot read browser storage: ' + idbError);
      }
      const local = new Map();
      for (const r of records) if (r && typeof r.relPath === 'string') local.set(r.relPath, r);

      const remote = await fetchServerIndex();
      const fromServer = [];
      if (remote) {
        for (const [rel, info] of remote) serverKnown.set(rel, info.mtime);
        await Promise.all([...remote].map(async ([rel, info]) => {
          const mine = local.get(rel);
          if (mine && mine.isDir) return;
          if (mine && mine.mtime >= info.mtime) {
            if (mine.deleted) serverJobs.set(rel, { op: 'delete' });
            else if (mine.mtime > info.mtime) serverJobs.set(rel, { op: 'put', rec: mine });
            return;
          }
          try {
            const res = await serverFetch(SERVER + 'file/' + encodePath(rel));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const contents = new Uint8Array(await res.arrayBuffer());
            const rec = { relPath: rel, isDir: false, mode: FILE_MODE, mtime: info.mtime, size: contents.byteLength, contents };
            local.set(rel, rec);
            fromServer.push(rec);
          } catch (e) {
            warn('[saves] Could not fetch ' + rel + ' from the disk backup: ' + (e.message || e));
          }
        }));
        for (const [rel, rec] of local) {
          if (!rec.isDir && !rec.deleted && rec.contents && !remote.has(rel)) serverJobs.set(rel, { op: 'put', rec });
        }
        if (fromServer.length) {
          append('[saves] ' + fromServer.length + ' save file(s) taken from the disk backup');
          await idbRun('readwrite', (store) => { for (const rec of fromServer) store.put(rec); })
            .catch((e) => warn('[saves] Could not copy disk backup into browser storage: ' + (e.message || e)));
        }
      }

      const list = [...local.values()].filter((r) => !r.deleted).sort((a, b) => a.relPath.localeCompare(b.relPath));
      let restoredCount = 0;
      suppressHooks = true;
      try {
        for (const rec of list) {
          if (!rec.relPath.split('/').every((seg) => seg && seg !== '.' && seg !== '..')) continue;
          const fullPath = fullOf(rec.relPath);
          try {
            if (rec.isDir) {
              FS.mkdirTree(fullPath);
            } else if (rec.contents) {
              const slash = fullPath.lastIndexOf('/');
              if (slash >= 0) FS.mkdirTree(fullPath.slice(0, slash));
              FS.writeFile(fullPath, rec.contents);
              if (rec.mode) {
                try { FS.chmod(fullPath, rec.mode); } catch (e) {}
              }
              try { FS.utime(fullPath, rec.mtime, rec.mtime); } catch (e) {}
              restoredCount++;
            } else {
              continue;
            }
            const st = statRel(rec.relPath);
            known.set(rec.relPath, { isDir: !!rec.isDir, mtime: st ? toMs(st.mtime) : rec.mtime, size: st ? st.size : rec.size });
          } catch (e) {
            warn('[saves] Error restoring ' + fullPath + ': ' + e);
          }
        }
      } finally {
        suppressHooks = false;
      }
      append(restoredCount ? '[saves] Restored ' + restoredCount + ' save file(s)' : '[saves] No existing saves found');
      restoreDone = true;
      if (serverJobs.size) mirror();
      if (idbError) toast('Browser save storage unavailable: ' + idbError, 'err');
      return restoredCount;
    }

    function requestPersistentStorage() {
      const s = navigator.storage;
      if (!s || !s.persist) return;
      s.persisted()
        .then((p) => p || s.persist())
        .then((granted) => {
          storagePersisted = granted;
          append('[saves] Persistent browser storage ' + (granted ? 'granted' : 'not granted (best-effort; keep the disk backup or export)'));
          updatePanel();
        })
        .catch(() => {});
    }

    // ── Emscripten mount + FS hooks ──────────────────────────────────────────
    const SaveFilesystem = {
      mount(mount) {
        return (FS.filesystems?.MEMFS || MEMFS).mount(mount);
      },
      // populate: the initial restore already ran. Otherwise (FS.syncfs, fsync on a save file): store now,
      // and report a real error to the engine when nothing durable took the data.
      syncfs(mount, populate, callback) {
        const p = populate ? (restorePromise || Promise.resolve()) : persist();
        p.then(() => callback(null), (e) => callback(e || new Error('save sync failed')));
      }
    };

    function isWriteOpen(flags) {
      if (typeof flags === 'string') return flags !== 'r';
      return (flags & 3) !== 0 || (flags & (64 | 512)) !== 0; // O_WRONLY/O_RDWR, O_CREAT, O_TRUNC
    }

    // Wraps one stream's ops so we know when the game is done writing it (close / fsync, including dups).
    function trackWriter(stream, rel) {
      const t = { rel, refs: 1, synced: false };
      const base = stream.stream_ops;
      const ops = Object.create(base);
      ops.write = function () {
        t.synced = false;
        return base.write.apply(this, arguments);
      };
      ops.fsync = function () {
        t.synced = true;
        markDirty(t.rel);
        return base.fsync ? base.fsync.apply(this, arguments) : 0;
      };
      ops.dup = function () {
        t.refs++;
        return base.dup ? base.dup.apply(this, arguments) : undefined;
      };
      ops.close = function (s) {
        try {
          return base.close ? base.close.apply(this, arguments) : undefined;
        } finally {
          if (--t.refs === 0) writerClosed(t, s);
        }
      };
      stream.stream_ops = ops;
      if (!writers.has(rel)) writers.set(rel, new Set());
      writers.get(rel).add(t);
      markDirty(rel);
    }

    function writerClosed(t, stream) {
      const set = writers.get(t.rel);
      if (set) {
        set.delete(t);
        if (!set.size) writers.delete(t.rel);
      }
      markDirty(t.rel);
      try {
        const now = relOf(FS.getPath(stream.node));
        if (now && now !== t.rel) markDirty(now);
      } catch (e) {}
      gameWrote = true;
      schedule(0);
    }

    function hookFS() {
      if (FS._savesHooked) return;
      FS._savesHooked = true;

      const origOpen = FS.open;
      FS.open = function (path, flags) {
        const stream = origOpen.apply(this, arguments);
        if (!suppressHooks) {
          try {
            const rel = relOf(stream.path);
            if (rel && isWriteOpen(flags) && FS.isFile(stream.node.mode)) trackWriter(stream, rel);
          } catch (e) {}
        }
        return stream;
      };

      const hookPath = (name, ...argIndexes) => {
        const orig = FS[name];
        FS[name] = function () {
          const res = orig.apply(this, arguments);
          let hit = false;
          for (const i of argIndexes) {
            try {
              const rel = typeof arguments[i] === 'string' ? relOf(arguments[i]) : null;
              if (rel) {
                markDirty(rel);
                hit = true;
              }
            } catch (e) {}
          }
          if (hit && !suppressHooks) schedule(0);
          return res;
        };
      };
      hookPath('rename', 0, 1);
      hookPath('unlink', 0);
      hookPath('rmdir', 0);
      hookPath('mkdir', 0);
      hookPath('truncate', 0);

      window.addEventListener('pagehide', flushNow);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
        else unloading = false;
      });
      // Ask the browser to hold the tab while a just-written save is still on its way to storage.
      window.addEventListener('beforeunload', (event) => {
        scanForChanges();
        const pending = inFlight > 0 || [...dirty].some(consistent);
        if (!pending) return;
        persist().catch(() => {});
        event.preventDefault();
        event.returnValue = '';
      });
      setInterval(() => {
        scanForChanges();
        if (dirty.size) persist().catch(() => {});
        else if (serverJobs.size && server !== 'off') mirror();
      }, SCAN_INTERVAL_MS);
    }

    // Page is going away or to the background: keepalive lets small mirror requests outlive the page.
    function flushNow() {
      unloading = true;
      scanForChanges();
      persist().catch(() => {});
    }

    function setupSavePersistence() {
      addRunDependency('restore-saves');
      try {
        FS.filesystems.IDBFS = SaveFilesystem;
        FS.mkdirTree(SAVE_ROOT);
        FS.mount(SaveFilesystem, {}, SAVE_ROOT);
      } catch (e) {
        console.warn('[saves] Mount setup notice:', e.message);
      }
      hookFS();
      requestPersistentStorage();
      restorePromise = restore();
      tail = restorePromise.catch(() => {});
      restorePromise
        .catch((err) => warn('[saves] Restore failed: ' + err))
        .finally(() => removeRunDependency('restore-saves'));
    }

    // ── Export / import ──────────────────────────────────────────────────────
    function toBase64(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }

    function fromBase64(text) {
      if (typeof text !== 'string') throw new Error('file data is not base64');
      const s = atob(text);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }

    async function collectForExport() {
      try {
        await persist();
      } catch (e) {}
      try {
        const records = (await idbRun('readonly', (store) => store.getAll())) || [];
        return records.filter((r) => !r.deleted && !r.isDir && r.contents);
      } catch (e) {
        // Browser storage unreadable: export straight from the game's FS.
        const out = [];
        if (typeof FS !== 'undefined') walk('', (rel, st) => { if (FS.isFile(st.mode)) out.push(fileRecord(rel, st)); });
        return out;
      }
    }

    function buildExport(records) {
      return JSON.stringify({
        format: EXPORT_FORMAT,
        version: 1,
        exported: new Date().toISOString(),
        origin: typeof location !== 'undefined' ? location.origin : '',
        files: records.map((r) => ({ path: r.relPath, mtime: r.mtime, size: r.contents.byteLength, data: toBase64(r.contents) })),
      });
    }

    async function exportSaves() {
      const records = await collectForExport();
      if (!records.length) {
        toast('No saves to export yet', 'info');
        return 0;
      }
      const blob = new Blob([buildExport(records)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      a.href = url;
      a.download = 'gta4-saves-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Exported ' + records.length + ' save file(s)', 'ok');
      return records.length;
    }

    // Validates a backup (this format, or the old array-of-records export) into [{ path, mtime, bytes }].
    function parseImport(input) {
      const data = typeof input === 'string' ? JSON.parse(input) : input;
      let entries;
      if (Array.isArray(data)) {
        entries = data.filter((x) => x && !x.isDir && !x.deleted).map((x) => {
          if (!Array.isArray(x.contents) && !(x.contents instanceof Uint8Array)) throw new Error('entry without contents: ' + x.relPath);
          return { path: x.relPath, mtime: x.mtime, bytes: Uint8Array.from(x.contents) };
        });
      } else if (data && data.format === EXPORT_FORMAT && Array.isArray(data.files)) {
        entries = data.files.map((f) => ({ path: f && f.path, mtime: f && f.mtime, bytes: fromBase64(f && f.data) }));
      } else {
        throw new Error('not a saves backup file');
      }
      if (!entries.length) throw new Error('the backup contains no save files');
      if (entries.length > MAX_IMPORT_FILES) throw new Error('too many files in the backup');
      const seen = new Set();
      for (const e of entries) {
        if (!cleanRelPath(e.path)) throw new Error('invalid path in backup: ' + JSON.stringify(e.path));
        if (seen.has(e.path)) throw new Error('duplicate path in backup: ' + e.path);
        if (e.bytes.byteLength > MAX_FILE_BYTES) throw new Error('file too large in backup: ' + e.path);
        seen.add(e.path);
      }
      return entries;
    }

    async function importSaves(input, options = {}) {
      if (input === undefined) {
        return new Promise((resolve) => {
          const picker = document.createElement('input');
          picker.type = 'file';
          picker.accept = '.json,application/json';
          picker.onchange = async () => {
            const file = picker.files && picker.files[0];
            if (!file) return resolve(0);
            try {
              resolve(await importSaves(await file.text(), options));
            } catch (e) {
              resolve(0);
            }
          };
          picker.click();
        });
      }
      let entries;
      try {
        entries = parseImport(input);
      } catch (e) {
        toast('Import failed: ' + e.message, 'err');
        throw e;
      }
      const confirmFn = options.confirm || ((text) => window.confirm(text));
      if (!confirmFn('Import ' + entries.length + ' save file(s)? Saves with the same name are replaced.')) return 0;
      if (restorePromise) await restorePromise.catch(() => {});
      const now = Date.now();
      const records = entries.map((e) => ({ relPath: e.path, isDir: false, mode: FILE_MODE, mtime: now, size: e.bytes.byteLength, contents: e.bytes }));
      try {
        await idbRun('readwrite', (store) => { for (const rec of records) store.put(rec); });
      } catch (e) {
        toast('Import failed: ' + (e.message || e), 'err');
        throw e;
      }
      // Put the files in the running game's FS too, so nothing stale overwrites them before the reload.
      if (typeof FS !== 'undefined') {
        suppressHooks = true;
        try {
          for (const rec of records) {
            const full = fullOf(rec.relPath);
            FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
            FS.writeFile(full, rec.contents);
            try { FS.utime(full, now, now); } catch (e) {}
            const st = statRel(rec.relPath);
            known.set(rec.relPath, { isDir: false, mtime: st ? toMs(st.mtime) : now, size: rec.size });
            dirty.delete(rec.relPath);
          }
        } catch (e) {
          warn('[saves] Imported into browser storage, but could not update the running game: ' + e);
        } finally {
          suppressHooks = false;
        }
      }
      for (const rec of records) serverJobs.set(rec.relPath, { op: 'put', rec });
      await mirror();
      append('[saves] Imported ' + records.length + ' save file(s)');
      toast('Imported ' + records.length + ' save file(s)', 'ok');
      if (confirmFn('Saves imported. Reload now so the game picks them up?')) location.reload();
      return records.length;
    }

    // ── UI: toast + F9 / Alt+S panel ────────────────────────────────────────────────
    const toastEl = typeof document !== 'undefined' ? document.getElementById('saves-toast') : null;
    const panelEl = typeof document !== 'undefined' ? document.getElementById('saves-panel') : null;
    let toastTimer = null;
    function toast(text, kind) {
      if (!toastEl) return;
      toastEl.textContent = text;
      toastEl.className = 'show ' + (kind || 'info');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.className = kind || 'info'; }, kind === 'err' ? 8000 : 2500);
    }

    function updatePanel() {
      if (!panelEl || panelEl.hidden) return;
      const status = panelEl.querySelector('.saves-status');
      if (!status) return;
      const files = [...known.values()].filter((k) => !k.isDir).length;
      const browser = idbError ? 'error: ' + idbError :
        files + ' file(s)' + (storagePersisted === true ? ', persistent' : storagePersisted === false ? ', best-effort' : '');
      const disk = server === 'ok' ? 'saves/ folder' : server === 'error' ? 'error: ' + serverError :
        server === 'off' ? 'not available' : 'checking';
      status.textContent = 'Browser: ' + browser + ' · Disk: ' + disk + ' · ' + location.host;
    }

    function togglePanel(show) {
      if (!panelEl) return;
      panelEl.hidden = show === undefined ? !panelEl.hidden : !show;
      if (!panelEl.hidden) {
        if (document.pointerLockElement) document.exitPointerLock();
        updatePanel();
      } else {
        document.getElementById('canvas')?.focus();
      }
    }

    if (panelEl) {
      // Keep clicks on the panel away from the game's mouse handlers.
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'wheel']) {
        panelEl.addEventListener(type, (event) => event.stopPropagation());
      }
      panelEl.addEventListener('click', (event) => {
        const action = event.target.closest('button')?.dataset.action;
        if (!action) return;
        event.target.blur();
        if (action === 'export') exportSaves().catch((e) => toast('Export failed: ' + (e.message || e), 'err'));
        else if (action === 'import') importSaves().catch(() => {});
        else if (action === 'close') togglePanel(false);
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      // F9, or Option/Alt+S for Mac keyboards where F-keys need Fn. event.code is used because
      // Option changes event.key on macOS (Option+S types "ß"). S is also "move back", so the
      // S keyup/repeats are swallowed only for a press that opened/closed the panel; a held S
      // that Alt is pressed during still reaches the game and gets its keyup.
      const isF9 = (event) => event.code === 'F9' || event.key === 'F9';
      const isAltS = (event) => event.code === 'KeyS' && event.altKey && !event.ctrlKey && !event.metaKey;
      let altSHeld = false;
      const swallow = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('keydown', (event) => {
        if (isF9(event)) {
          swallow(event);
          if (!event.repeat) togglePanel();
        } else if (event.code === 'KeyS' && altSHeld) {
          swallow(event);
        } else if (isAltS(event) && !event.repeat) {
          swallow(event);
          altSHeld = true;
          togglePanel();
        }
      }, true);
      window.addEventListener('keyup', (event) => {
        if (isF9(event)) swallow(event);
        else if (event.code === 'KeyS' && altSHeld) {
          altSHeld = false;
          swallow(event);
        }
      }, true);
      window.addEventListener('blur', () => { altSHeld = false; });
    }

    window.exportSaves = exportSaves;
    window.importSaves = importSaves;
    globalThis.LibertySaves = {
      setup: setupSavePersistence,
      persist,
      exportSaves,
      importSaves,
      togglePanel,
      // For tests.
      _internal: { cleanRelPath, parseImport, buildExport, scanForChanges, state: () => ({ known, dirty, writers, serverJobs, serverKnown, server, idbError }) },
    };
})();

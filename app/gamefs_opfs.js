// Origin Private File System (OPFS) mirror of the big game archives, so engine pthreads can read them with
// FileSystemSyncAccessHandle instead of blocking on a loopback XHR for every 1 MB chunk miss.
//
// This one file plays three roles:
//   - helpers (LibertyOPFS / module.exports): naming, planning and pacing, pure so node can test them;
//   - the copier, when it runs as a dedicated worker named 'liberty-opfs' (started by gamefs.js on the page):
//     it streams files from the server into OPFS, one at a time, resumably;
//   - pthreads importScripts() it from gamefs.js for the helpers and openReadHandles().
//
// A file only counts as cached once it is complete: the copier writes '<name>.part' and renames it to
// '<name>' after the size checks out. The name carries the index version, so a replaced server file simply
// has a different name; whatever the current index does not name is deleted on the next copier run.
'use strict';

(function () {
    const DIR = 'liberty-gamefs';
    const PART = '.part', PROBE = '.probe';
    // Small files are read once or twice and XHR serves them fine; the >= 4 MB files are ~110 of ~1.7k files
    // but ~97% of the bytes, and every open handle costs each pthread a file descriptor.
    const MIN_SIZE = 4 << 20;
    // Room left for saves, the HTTP cache and other origins' growth after the copy.
    const QUOTA_MARGIN = 512 << 20;

    // '/' is not allowed in an OPFS name, and a flat directory keeps listing and invalidation trivial.
    const nameOf = (path, size, version) => encodeURIComponent(path) + '@' + (version || 's' + size.toString(36));

    // Streaming archives first (texture/model pop-in is what we are fighting), then other archives, audio,
    // and finally movies; smaller files first within a group so useful files land early.
    const rank = (path) => {
      const p = path.toLowerCase();
      if (/\.bik$/.test(p)) return 3;
      if (/(^|\/)audio\//.test(p)) return 2;
      if (/\.img$/.test(p)) return 0;
      return 1;
    };

    // files: index entries [path, size, version]; entries: Map(OPFS name -> size, or -1 if unknown).
    // Returns which files are complete, which still need copying (with the bytes already in their .part),
    // and which OPFS entries belong to no current file (old versions, files gone from the index).
    const plan = (files, entries, minSize = MIN_SIZE) => {
      const ready = [], todo = [], stale = [], keep = new Set([PROBE]);
      files.forEach(([path, size, version], index) => {
        if (!(size >= minSize)) return;
        const name = nameOf(path, size, version);
        keep.add(name); keep.add(name + PART);
        const have = entries.get(name), part = entries.get(name + PART);
        if (have === size) {
          ready.push(index);
          if (part !== undefined) stale.push(name + PART);
          return;
        }
        // A wrong-sized final file can only be damage; drop it (an unknown size, -1, is left alone because
        // another tab may hold it open and we could not stat it).
        if (have !== undefined && have >= 0) stale.push(name);
        if (have === -1) return;
        todo.push({ index, path, size, name, offset: part > 0 && part <= size ? part : 0 });
      });
      for (const name of entries.keys()) if (!keep.has(name)) stale.push(name);
      todo.sort((a, b) => (b.offset > 0) - (a.offset > 0) || rank(a.path) - rank(b.path) || a.size - b.size);
      return { ready, todo, stale };
    };

    // Picks the todo items that fit in the free quota (keeping QUOTA_MARGIN), in order; one that does not
    // fit is skipped so a smaller one after it can still be cached.
    const fitQuota = (todo, free, margin = QUOTA_MARGIN) => {
      let budget = free - margin;
      const take = [], skip = [];
      for (const item of todo) {
        const need = item.size - item.offset;
        if (need <= budget) { take.push(item); budget -= need; } else skip.push(item);
      }
      return { take, skip };
    };

    // Milliseconds to sleep so `bytes` copied in `elapsedMs` stays at or under `rate` bytes/s (0: unlimited).
    const delayFor = (bytes, elapsedMs, rate) => rate > 0 ? Math.max(0, bytes * 1000 / rate - elapsedMs) : 0;

    // Resuming backs off to a whole MB below what the .part holds: writes since the last flush() may not
    // have reached the disk if the machine (not just the tab) went down.
    const resumeOffset = (partSize) => Math.max(0, Math.floor(partSize / (1 << 20)) - 1) * (1 << 20);

    // Chrome 121+ accepts createSyncAccessHandle({ mode: 'read-only' }) and lets any number of read-only
    // handles share a file. Older Chrome (and Firefox/Safari, which have no `mode`) silently ignores the
    // option and hands out the exclusive readwrite lock, so ask for two handles and see if the second works.
    // Any failure means "unsupported", which keeps everyone on XHR.
    const probeMultiReader = async (dir) => {
      let a = null, b = null;
      try {
        const file = await dir.getFileHandle(PROBE, { create: true });
        a = await file.createSyncAccessHandle({ mode: 'read-only' });
        b = await file.createSyncAccessHandle({ mode: 'read-only' });
        return true;
      } catch (e) {
        return false;
      } finally {
        try { a && a.close(); } catch (e) { /* already closed */ }
        try { b && b.close(); } catch (e) { /* already closed */ }
      }
    };

    // Pthread side: opens a read-only handle for every complete cached file. Returns Map(index -> handle).
    // Needs the copier's directory to exist; never creates it.
    const openReadHandles = async (files, minSize = MIN_SIZE) => {
      const handles = new Map();
      if (!globalThis.navigator || !navigator.storage || !navigator.storage.getDirectory ||
          typeof FileSystemFileHandle === 'undefined' || !FileSystemFileHandle.prototype.createSyncAccessHandle)
        return handles;
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR);
      if (!await probeMultiReader(dir)) return handles;
      await Promise.all(files.map(async ([path, size, version], index) => {
        if (!(size >= minSize)) return;
        let handle = null;
        try {
          const file = await dir.getFileHandle(nameOf(path, size, version));
          handle = await file.createSyncAccessHandle({ mode: 'read-only' });
          if (handle.getSize() === size) { handles.set(index, handle); handle = null; }
        } catch (e) {
          // Not cached (NotFoundError), or locked by a copier: XHR it is.
        } finally {
          if (handle) handle.close();
        }
      }));
      return handles;
    };

    const helpers = { DIR, PART, PROBE, MIN_SIZE, QUOTA_MARGIN, nameOf, rank, plan, fitQuota, delayFor, resumeOffset,
      probeMultiReader, openReadHandles };
    if (typeof module === 'object' && module.exports) module.exports = helpers;
    globalThis.LibertyOPFS = helpers;

    if (typeof document !== 'undefined' || typeof WorkerGlobalScope === 'undefined' || self.name !== 'liberty-opfs') return;

    // ---- Copier (dedicated worker, not a pthread: it may await freely and never blocks the engine) ----
    const post = (msg) => self.postMessage(msg);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const FLUSH_EVERY = 64 << 20;
    let stopped = false;

    const openDir = async (create) => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create });

    const listEntries = async (dir) => {
      const entries = new Map();
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        try { entries.set(name, (await handle.getFile()).size); } catch (e) { entries.set(name, -1); }
      }
      return entries;
    };

    // Streams one file into '<name>.part' through a sync access handle (fast, and this worker is the only
    // writer thanks to the Web Lock), then renames it. Returns the bytes written.
    const copyOne = async (dir, item, url, pace) => {
      const partFile = await dir.getFileHandle(item.name + PART, { create: true });
      const access = await partFile.createSyncAccessHandle();
      let written = 0;
      try {
        let offset = resumeOffset(Math.min(access.getSize(), item.size));
        access.truncate(offset);
        if (offset < item.size) {
          // no-store: these are year-long immutable responses; letting a 800 MB body into the HTTP cache
          // as well would store every byte twice.
          let response = await fetch(url, { cache: 'no-store', headers: offset ? { Range: 'bytes=' + offset + '-' } : {} });
          if (offset && response.status === 200) { offset = 0; access.truncate(0); }
          else if (!response.ok || (offset && response.status !== 206)) throw new Error('HTTP ' + response.status);
          const reader = response.body.getReader();
          let sinceFlush = 0;
          for (;;) {
            if (stopped) { reader.cancel().catch(() => {}); return written; }
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.length > item.size) throw new Error('longer than the index says');
            let at = 0;
            while (at < value.length) at += access.write(value.subarray(at), { at: offset + at });
            offset += value.length; written += value.length; sinceFlush += value.length;
            if (sinceFlush >= FLUSH_EVERY) { access.flush(); sinceFlush = 0; }
            await pace(value.length, item);
          }
        }
        access.flush();
        if (access.getSize() !== item.size) throw new Error('size ' + access.getSize() + ' != ' + item.size);
      } finally {
        access.close();
      }
      // Fails if a stale final file is still held open by another tab; the .part is kept for next time.
      await partFile.move(item.name);
      return written;
    };

    const copyAll = async ({ files, rate }) => {
      let dir;
      try { dir = await openDir(true); } catch (e) {
        return post({ type: 'unavailable', reason: 'OPFS refused (' + e.name + '), e.g. private browsing' });
      }
      if (!await probeMultiReader(dir))
        return post({ type: 'unavailable', reason: 'no shared read-only sync access handles (needs Chrome 121+)' });
      const entries = await listEntries(dir);
      const { ready, todo, stale } = plan(files, entries);
      for (const name of stale) await dir.removeEntry(name).catch(() => {});
      let take = todo, skip = [];
      try {
        const { quota, usage } = await navigator.storage.estimate();
        ({ take, skip } = fitQuota(todo, quota - usage));
      } catch (e) { /* no estimate: try, and stop at the first QuotaExceededError */ }
      const total = take.reduce((n, item) => n + item.size - item.offset, 0);
      post({ type: 'plan', ready: ready.length, copy: take.length, skipped: skip.length, totalBytes: total,
             staleRemoved: stale.length });
      let copied = 0, filesDone = 0, failed = 0, lastPost = 0;
      const started = Date.now();
      const pace = async (n, item) => {
        copied += n;
        const now = Date.now();
        if (now - lastPost > 1000) { lastPost = now; post({ type: 'progress', bytes: copied, totalBytes: total, file: item.path }); }
        const wait = delayFor(copied, now - started, rate);
        if (wait > 0) await sleep(Math.min(wait, 1000));
      };
      for (const item of take) {
        if (stopped) break;
        try {
          await copyOne(dir, item, files[item.index][3], pace);
          if (stopped) break;
          filesDone++;
          post({ type: 'file', path: item.path, index: item.index });
        } catch (e) {
          failed++;
          if (e && e.name === 'QuotaExceededError') { post({ type: 'quota', path: item.path }); break; }
          post({ type: 'error', path: item.path, message: String(e && e.message || e) });
        }
      }
      post({ type: 'done', files: filesDone, failed, bytes: copied, stopped, ms: Date.now() - started });
    };

    self.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'stop') { stopped = true; return; }
      const supported = typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory &&
        typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createSyncAccessHandle &&
        FileSystemFileHandle.prototype.move;
      if (!supported) return post({ type: 'unavailable', reason: 'no OPFS sync access handles' });
      const run = msg.type === 'clear'
        ? async () => {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(DIR, { recursive: true }).catch((e) => { if (e.name !== 'NotFoundError') throw e; });
          post({ type: 'cleared' });
        }
        : () => copyAll(msg);
      // One copier per origin: a second tab would fight over the same .part files.
      const locked = navigator.locks
        ? navigator.locks.request('liberty-opfs-copy', { ifAvailable: true },
          (lock) => lock ? run() : post({ type: 'busy' }))
        : run();
      Promise.resolve(locked).catch((e) => post({ type: 'unavailable', reason: String(e && e.message || e) }));
    };
})();

// Mounts the server's game files into the emscripten FS as lazily fetched, read-only nodes.
//
// The engine runs on a pthread, and emscripten proxies every FS syscall to the page thread, which
// also feeds audio and handles input; a synchronous chunk download there stalls both. So on loopback
// the page thread only opens and closes game files: it records each open fd (file index and a shared
// position) in a SharedArrayBuffer, and liberty.js lets pthreads answer fd_read / fd_pread / fd_seek
// for those fds themselves with synchronous XHRs (the pthread half below). Everything else (stat,
// close, mmap, remote mode) still goes through the page-thread path.
//
// OPFS: those XHRs still block the streaming thread for a round trip per chunk miss. On loopback the page
// also starts gamefs_opfs.js as a worker that copies the big archives into the Origin Private File System,
// and pthreads read complete copies with FileSystemSyncAccessHandle (a plain pread) instead. ?opfs=off
// disables both halves, ?opfs=clear deletes the copy.
'use strict';

(function () {
    // index.json entries are [path, size, version]; the version keeps replaced files out of the browser cache.
    const versions = new Map();
    const noteVersions = (files) => { for (const [path, , version] of files) if (version) versions.set(path, version); return files; };
    const urlOf = (path) => '/game/' + path.split('/').map(encodeURIComponent).join('/') +
      (versions.has(path) ? '?v=' + versions.get(path) : '');
    const EIO = 29, ENOMEM = 48, EINVAL = 28;   // emscripten's (WASI) errno numbers
    // Shared fd table: fdFile[fd] = file index + 1 (0: not a game file), fdSlot[fd] = position slot.
    // dup()ed fds share a slot, like POSIX file descriptions share an offset. fileCount lets pthreads
    // check that their copy of the index matches the page's. opfs = [enabled, max ms a new pthread waits
    // for its OPFS handles]: pthread workers do not see the page's URL, so the toggle travels here.
    const MAX_FDS = 4096, MAX_SLOTS = 1024, SHARED_BYTES = MAX_FDS * 8 + MAX_SLOTS * 8 + 16;
    const views = (shared) => ({
      fdFile: new Int32Array(shared, 0, MAX_FDS),
      fdSlot: new Int32Array(shared, MAX_FDS * 4, MAX_FDS),
      position: new BigInt64Array(shared, MAX_FDS * 8, MAX_SLOTS),
      fileCount: new Int32Array(shared, MAX_FDS * 8 + MAX_SLOTS * 8, 1),
      opfs: new Int32Array(shared, MAX_FDS * 8 + MAX_SLOTS * 8 + 4, 2),
    });

    if (typeof document === 'undefined') {
      // Pthread half, loaded by liberty.js when the page passes the shared table.
      let table = null, files = null;
      // Every chunk miss is a blocking loopback request on the streaming thread, so fetch 1 MB at a time
      // (4x fewer round trips) and keep 256 MB per thread so revisited areas don't hit the server again.
      const WCHUNK = 1 << 20, MAX_WCACHE = 256 << 20, DIRECT = 1 << 20;
      const cache = new Map();
      let cachedBytes = 0;
      const fetchRange = (url, start, end) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
        xhr.responseType = 'arraybuffer';
        try { xhr.send(); } catch (e) { throw EIO; }
        // A 200 means the Range header was ignored; anything short would leave holes.
        if (xhr.status !== 206 || !xhr.response || xhr.response.byteLength !== end - start + 1) throw EIO;
        return new Uint8Array(xhr.response);
      };
      const chunkOf = (url, index, size) => {
        const key = url + '#' + index;
        let bytes = cache.get(key);
        if (bytes) {
          cache.delete(key); cache.set(key, bytes);
          return bytes;
        }
        const start = index * WCHUNK;
        bytes = fetchRange(url, start, Math.min(size, start + WCHUNK) - 1);
        cache.set(key, bytes);
        cachedBytes += bytes.length;
        for (const [old, oldBytes] of cache) {
          if (cachedBytes <= MAX_WCACHE) break;
          cache.delete(old); cachedBytes -= oldBytes.length;
        }
        return bytes;
      };
      // OPFS read: a synchronous pread on the worker's own read-only handle, no round trip. Reads straight
      // into the (shared) wasm heap; if this Chrome rejects shared views, bounce through a private buffer.
      // Returns the bytes read, which is short only if the handle failed (the caller XHRs the rest).
      let directOk = true, bounce = null;
      const readHandle = (file, ptr, length, position) => {
        const handle = file[2];
        let done = 0;
        try {
          while (done < length) {
            let n;
            growMemViews();
            if (directOk) {
              try {
                n = handle.read(HEAPU8.subarray(ptr + done, ptr + length), { at: position + done });
              } catch (e) {
                if (!(e instanceof TypeError)) throw e;
                directOk = false;
                continue;
              }
            } else {
              bounce = bounce || new Uint8Array(4 << 20);
              const want = Math.min(bounce.length, length - done);
              n = handle.read(bounce.subarray(0, want), { at: position + done });
              growMemViews();
              HEAPU8.set(bounce.subarray(0, n), ptr + done);
            }
            if (!(n > 0)) throw new Error('short read');
            done += n;
          }
        } catch (e) {
          // A closed or invalidated handle, or a copy shorter than the index says: stop trusting it.
          try { handle.close(); } catch (e2) { /* already closed */ }
          file[2] = null;
        }
        return done;
      };
      // Copies [position, position + length) of a file into the wasm heap at ptr; returns the count.
      const readInto = (file, ptr, length, position) => {
        const url = file[0], size = file[1];
        if (position >= size) return 0;
        length = Math.min(length, size - position);
        if (file[2]) {
          const n = readHandle(file, ptr, length, position);
          if (n === length) return n;
          ptr += n; position += n;
          return n + readInto(file, ptr, length - n, position);
        }
        // Big reads go straight to the heap in one request instead of churning the chunk cache.
        if (length >= DIRECT) {
          const bytes = fetchRange(url, position, position + length - 1);
          growMemViews();
          HEAPU8.set(bytes, ptr);
          return length;
        }
        let done = 0;
        while (done < length) {
          const at = position + done, index = Math.floor(at / WCHUNK);
          const chunk = chunkOf(url, index, size);
          const from = at - index * WCHUNK, n = Math.min(length - done, chunk.length - from);
          if (n <= 0) throw EIO;
          growMemViews();
          HEAPU8.set(chunk.subarray(from, from + n), ptr + done);
          done += n;
        }
        return done;
      };
      // files[i] = [url, size, OPFS handle or null/undefined].
      const loadFiles = (index) => {
        files = noteVersions(index).map(([path, size]) => [urlOf(path), size]);
        // A different index (the server was restarted on other files) would map fds to the wrong
        // files; leave every read to the page thread then.
        if (table && files.length !== Atomics.load(table.fileCount, 0)) table = null;
      };
      const fileOf = (fd) => {
        if (!table || fd < 0 || fd >= MAX_FDS) return null;
        const file = Atomics.load(table.fdFile, fd);
        if (!file) return null;
        if (!files) {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/game/index.json', false);
          try { xhr.send(); } catch (e) { return null; }
          if (xhr.status !== 200) return null;
          loadFiles(JSON.parse(xhr.responseText).files);
        }
        if (!table) return null;
        return files[file - 1] || null;
      };
      // FileSystemSyncAccessHandles cannot be posted between workers, and getting one is async, which a
      // pthread can only do while its worker sits in the event loop: once the C thread runs it is in wasm
      // (or Atomics.wait) for good, and promises started then would never settle. So the handles are opened
      // while the worker is being set up, and the thread's start is held back (bounded by opfs[1] ms) until
      // they are; liberty.js calls attach() right before startWorker(), which runs the queued "run" message.
      // A worker reused for a later thread keeps its handles. Files copied while the session runs are
      // picked up by pthreads created afterwards, and by everyone on the next load.
      const openOpfs = () => {
        try { importScripts('gamefs_opfs.js'); } catch (e) { return null; }
        const OPFS = globalThis.LibertyOPFS;
        return (async () => {
          const response = await fetch('/game/index.json', { cache: 'no-store' });
          if (!response.ok) return 0;
          const index = (await response.json()).files;
          const handles = await OPFS.openReadHandles(index);
          if (!files) loadFiles(index);
          if (!table || files.length !== index.length) { for (const handle of handles.values()) handle.close(); return 0; }
          for (const [i, handle] of handles) files[i][2] = handle;
          return handles.size;
        })().catch(() => 0);
      };
      globalThis.LibertyGameFS = {
        attach(shared) {
          table = views(shared);
          if (!Atomics.load(table.opfs, 0) || typeof startWorker !== 'function') return;
          const opened = openOpfs();
          if (!opened) return;
          LibertyGameFS.opfsReady = opened;
          const start = startWorker, wait = Atomics.load(table.opfs, 1);
          let started = false;
          const go = () => { if (!started) { started = true; start(); } };
          // startWorker is liberty.js's top-level `var`, so this replaces the call it is about to make.
          startWorker = () => { opened.then(go); setTimeout(go, wait); };
        },
        // fd_read (offset undefined) / fd_pread for a game-file fd; undefined means "not ours, proxy it".
        // Arguments arrive as the raw syscall values (i64 as BigInt).
        read(fd, iov, iovcnt, offset, pnum) {
          const file = fileOf(fd);
          if (!file) return undefined;
          const slot = Atomics.load(table.fdSlot, fd);
          let position = offset === undefined ? Number(Atomics.load(table.position, slot)) : Number(offset);
          if (!(position >= 0)) return EINVAL;
          iov = Number(iov); iovcnt = Number(iovcnt); pnum = Number(pnum);
          let total = 0;
          try {
            for (let i = 0; i < iovcnt; i++, iov += 16) {
              growMemViews();
              const ptr = Number(HEAPU64[iov / 8]), len = Number(HEAPU64[(iov + 8) / 8]);
              const n = readInto(file, ptr, len, position);
              total += n; position += n;
              if (n < len) break;
            }
          } catch (e) {
            if (e === EIO) return EIO;
            throw e;
          }
          if (offset === undefined) Atomics.store(table.position, slot, BigInt(position));
          growMemViews();
          HEAPU64[pnum / 8] = BigInt(total);
          return 0;
        },
        seek(fd, offset, whence, newOffset) {
          const file = fileOf(fd);
          if (!file) return undefined;
          const slot = Atomics.load(table.fdSlot, fd);
          let position = Number(offset);
          if (whence === 1) position += Number(Atomics.load(table.position, slot));
          else if (whence === 2) position += file[1];
          else if (whence !== 0) return EINVAL;
          if (!(position >= 0)) return EINVAL;
          Atomics.store(table.position, slot, BigInt(position));
          growMemViews();
          HEAP64[Number(newOffset) / 8] = BigInt(position);
          return 0;
        },
      };
      return;
    }

    const append = (line) => LibertyBoot.log(line, false);
    const statusEl = document.getElementById('boot-status');
    // ?preload=1 / ?preload=0 override the hostname check, e.g. for an SSH
    // tunnel, where the browser sees localhost but the data crosses a network.
    const forced = new URLSearchParams(location.search).get('preload');
    const REMOTE = forced === '1' ? true : forced === '0' ? false
      : !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    // Created before liberty.js starts any pthread; they receive it in their load message.
    // Remote mode keeps every read on the page thread so its preload cache and read-ahead apply.
    const shared = !REMOTE && typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated
      ? new SharedArrayBuffer(SHARED_BYTES) : null;
    const table = shared && views(shared);
    const slotRefs = new Int32Array(MAX_SLOTS);
    // OPFS copy only helps the pthread read path, so it exists only where that does (loopback).
    //   ?opfs=off      no copying, every pthread read stays on XHR
    //   ?opfs=clear    delete the copy (and stay off for this load)
    //   ?opfs-rate=N   copy at most N MB/s (default 50; 0 = unthrottled), to leave the disk to the game
    //   ?opfs-wait=N   a new pthread waits at most N ms for its OPFS handles (default 500)
    const params = new URLSearchParams(location.search);
    const opfsMode = params.get('opfs');
    const opfsNumber = (name, fallback) => {
      const value = Number(params.get(name));
      return params.has(name) && value >= 0 ? value : fallback;
    };
    const OPFS = table && opfsMode !== 'off' && typeof Worker !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory);
    if (OPFS && opfsMode !== 'clear') {
      Atomics.store(table.opfs, 0, 1);
      Atomics.store(table.opfs, 1, Math.min(10000, opfsNumber('opfs-wait', 500)));
    }
    const opfsStatus = { state: OPFS ? 'pending' : 'off', ready: 0, copied: 0, bytes: 0, totalBytes: 0, file: '' };

    // Runs the copier worker (gamefs_opfs.js). Purely an optimisation: every failure just leaves XHR in charge.
    function startOpfsCopy(files) {
      let worker;
      try { worker = new Worker('gamefs_opfs.js', { name: 'liberty-opfs' }); } catch (e) { opfsStatus.state = 'off'; return; }
      opfsStatus.stop = () => worker.postMessage({ type: 'stop' });
      let lastQuarter = 0;
      worker.onerror = () => { opfsStatus.state = 'off'; };
      worker.onmessage = ({ data }) => {
        switch (data.type) {
          case 'unavailable': opfsStatus.state = 'off'; append('OPFS cache off: ' + data.reason); break;
          case 'busy': opfsStatus.state = 'busy'; append('OPFS cache: another tab is copying'); break;
          case 'cleared': opfsStatus.state = 'off'; append('OPFS cache cleared'); break;
          case 'plan':
            opfsStatus.state = data.copy ? 'copying' : 'complete';
            opfsStatus.ready = data.ready; opfsStatus.totalBytes = data.totalBytes;
            append('OPFS cache: ' + data.ready + ' files ready' + (data.copy ? ', copying ' + data.copy +
              ' (' + (data.totalBytes / 1048576 | 0) + ' MB)' : '') +
              (data.skipped ? ', ' + data.skipped + ' skipped for lack of quota' : ''));
            break;
          case 'progress': {
            opfsStatus.bytes = data.bytes; opfsStatus.file = data.file;
            const quarter = Math.floor(data.bytes * 4 / Math.max(1, data.totalBytes));
            if (quarter > lastQuarter) { lastQuarter = quarter; append('OPFS cache: ' + quarter * 25 + '% copied'); }
            break;
          }
          case 'file': opfsStatus.copied++; break;
          case 'quota': append('OPFS cache: out of quota at ' + data.path); break;
          case 'error': append('OPFS cache: ' + data.path + ': ' + data.message); break;
          case 'done':
            opfsStatus.state = data.stopped ? 'stopped' : 'complete';
            if (data.files || data.failed) append('OPFS cache: copied ' + data.files + ' files' +
              (data.failed ? ', ' + data.failed + ' failed' : '') + '; used from the next load');
            worker.terminate();
            break;
        }
      };
      if (opfsMode === 'clear') { worker.postMessage({ type: 'clear' }); return; }
      // Ask the browser not to evict ~6 GB under storage pressure. Window-only API; best effort.
      if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
      worker.postMessage({ type: 'start', rate: opfsNumber('opfs-rate', 50) * 1048576,
                           files: files.map(([path, size, version]) => [path, size, version, urlOf(path)]) });
    }

    function mountGameFiles() {
      const probe = new XMLHttpRequest();
      probe.open('GET', '/game/index.json', false);
      try { probe.send(); } catch (e) { /* reported below */ }
      if (probe.status !== 200) {
        // Without the index the engine would boot with no data; hold main() back and say why.
        addRunDependency('game-files');
        LibertyBoot.fatal('Game files missing', 'Could not load /game/index.json (HTTP ' + probe.status +
          '). Start the server from the folder that holds your extracted game files.');
        return;
      }
      const files = noteVersions(JSON.parse(probe.responseText).files);
      if (table) Atomics.store(table.fileCount, 0, files.length);
      const root = '/data/LibertyRecomp/game';
      ENV.XDG_DATA_HOME = '/data';
      const CHUNK = 4 << 20;
      // Remote visitors preload PRELOAD_BYTES before the game starts; the cache
      // has to hold all of it, with headroom for read-ahead. Locally the page
      // thread only serves mmap and fds outside the shared table.
      const PRELOAD_BYTES = 500 << 20, MAX_CACHED = REMOTE ? PRELOAD_BYTES + 32 * CHUNK : 64 << 20;
      // Reads block the title, so over a slow link every uncached chunk stalls
      // the game (and its clocks) for a full round trip. After each read, fetch
      // the next chunks asynchronously so later reads hit the cache.
      // Local reads are fast enough that this would only add load, so it is
      // skipped on loopback.
      const READ_AHEAD = REMOTE ? 3 : 0, MAX_PENDING = 4;
      const cache = new Map();
      const pending = new Set();
      let cachedBytes = 0;
      const remember = (key, bytes) => {
        if (cache.has(key)) return;
        cache.set(key, bytes);
        cachedBytes += bytes.length;
        for (const [old, oldBytes] of cache) {
          if (cachedBytes <= MAX_CACHED) break;
          cache.delete(old); cachedBytes -= oldBytes.length;
        }
      };
      // Range responses must be a 206 of exactly the requested length; a 200 means a proxy
      // ignored Range and sent the whole file (or something else), which would corrupt reads.
      const chunkFetch = (url, index, size) => {
        const start = index * CHUNK, end = Math.min(size, start + CHUNK) - 1;
        return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
          .then((r) => r.status === 206 ? r.arrayBuffer() : null)
          .then((buf) => (buf && buf.byteLength === end - start + 1) ? new Uint8Array(buf) : null);
      };
      const prefetchChunk = (url, index, size) => {
        const key = url + '#' + index;
        if (index * CHUNK >= size || cache.has(key) || pending.has(key) || pending.size >= MAX_PENDING) return;
        pending.add(key);
        chunkFetch(url, index, size)
          .then((bytes) => { if (bytes) remember(key, bytes); })
          .catch(() => {})
          .finally(() => pending.delete(key));
      };
      const fetchChunk = (url, index, size) => {
        const key = url + '#' + index;
        let bytes = cache.get(key);
        if (bytes) {
          cache.delete(key); cache.set(key, bytes);
        } else {
          bytes = readChunk(url, index, size);
        }
        for (let ahead = 1; ahead <= READ_AHEAD; ahead++) prefetchChunk(url, index + ahead, size);
        return bytes;
      };
      const readChunk = (url, index, size) => {
        const key = url + '#' + index;
        const start = index * CHUNK, end = Math.min(size, start + CHUNK) - 1;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
        // Synchronous XHR on the page thread cannot return an ArrayBuffer; decode the text instead.
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        try { xhr.send(); } catch (e) { throw new FS.ErrnoError(EIO); }
        if (xhr.status !== 206) throw new FS.ErrnoError(EIO);
        const text = xhr.responseText;
        if (text.length !== end - start + 1) throw new FS.ErrnoError(EIO);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        remember(key, bytes);
        return bytes;
      };
      // Shared-table bookkeeping for fds that pthreads read directly. The stream's position lives in
      // the table; it is kept on the stream's `shared` object, which FS.dupStream shares between fds.
      const track = (stream, file) => {
        const fd = stream.fd;
        if (!table || fd < 0 || fd >= MAX_FDS || (stream.flags & 2097155) !== 0) return;
        const slot = slotRefs.indexOf(0);
        if (slot < 0) return;
        slotRefs[slot] = 1;
        Atomics.store(table.position, slot, BigInt(stream.position || 0));
        stream.shared = {
          flags: stream.shared.flags,
          slot,
          get position() { return Number(Atomics.load(table.position, slot)); },
          set position(value) { Atomics.store(table.position, slot, BigInt(value)); },
        };
        Atomics.store(table.fdSlot, fd, slot);
        Atomics.store(table.fdFile, fd, file + 1);
      };
      const trackDup = (stream, file) => {
        const fd = stream.fd, slot = stream.shared.slot;
        if (slot === undefined || fd < 0 || fd >= MAX_FDS) return;
        slotRefs[slot]++;
        Atomics.store(table.fdSlot, fd, slot);
        Atomics.store(table.fdFile, fd, file + 1);
      };
      const untrack = (stream) => {
        const fd = stream.fd, slot = stream.shared.slot;
        if (slot === undefined || fd < 0 || fd >= MAX_FDS || !Atomics.load(table.fdFile, fd)) return;
        Atomics.store(table.fdFile, fd, 0);
        slotRefs[slot]--;
      };
      files.forEach(([path, size], file) => {
        const slash = path.lastIndexOf('/');
        const dir = root + (slash >= 0 ? '/' + path.slice(0, slash) : '');
        FS.mkdirTree(dir);
        const node = FS.createFile(dir, path.slice(slash + 1), null, true, false);
        const url = urlOf(path);
        node.usedBytes = size;
        node.stream_ops = Object.assign({}, node.stream_ops, {
          open(stream) { track(stream, file); },
          dup(stream) { trackDup(stream, file); },
          close(stream) { untrack(stream); },
          read(stream, buffer, offset, length, position) {
            if (position >= size) return 0;
            length = Math.min(length, size - position);
            let done = 0;
            while (done < length) {
              const at = position + done, index = Math.floor(at / CHUNK);
              const chunk = fetchChunk(url, index, size);
              const from = at - index * CHUNK, n = Math.min(length - done, chunk.length - from);
              if (n <= 0) throw new FS.ErrnoError(EIO);
              buffer.set(chunk.subarray(from, from + n), offset + done);
              done += n;
            }
            return done;
          },
          // The title maps files (default.xex, the disc images) rather than
          // reading them; copy the mapped range in like MEMFS does.
          mmap(stream, length, position) {
            const ptr = mmapAlloc(length);
            if (!ptr) throw new FS.ErrnoError(ENOMEM);
            node.stream_ops.read(stream, HEAP8, ptr, length, position);
            return { ptr, allocated: true };
          },
        });
      });
      // Remote devices download the first PRELOAD_BYTES before the game starts
      // (run dependency holds main() back): the files the opening reads first,
      // then the rest in manifest order. Local access skips this.
      if (REMOTE) {
        const sizes = new Map(files);
        const first = ['xbox360.rpf', 'common.rpf', 'xbox360/anim/anim.img', 'xbox360/audio/sfx/speech.rpf',
                       'xbox360/models/cdimages/componentpeds.img', 'xbox360/data/cdimages/navmeshes.img']
          .filter((p) => sizes.has(p));
        const queue = [];
        for (const path of first) for (let i = 0; i < 8 && i * CHUNK < sizes.get(path); i++) queue.push([path, i]);
        for (const path of first.concat(files.map((f) => f[0]).filter((p) => !first.includes(p))))
          for (let i = 0; i * CHUNK < sizes.get(path); i++) queue.push([path, i]);
        const total = Math.min(PRELOAD_BYTES, queue.length * CHUNK);
        let loaded = 0, next = 0, active = 0;
        const seen = new Set();
        addRunDependency('preload-game');
        const finish = () => { statusEl.textContent = 'Starting…'; removeRunDependency('preload-game'); };
        const pump = () => {
          while (active < 6 && loaded < PRELOAD_BYTES && next < queue.length) {
            const [path, index] = queue[next++];
            const key = path + '#' + index;
            if (seen.has(key)) continue;
            seen.add(key);
            const url = urlOf(path);
            active++;
            chunkFetch(url, index, sizes.get(path))
              .then((bytes) => {
                if (!bytes) return;
                remember(url + '#' + index, bytes);
                loaded += bytes.length;
              })
              .catch(() => {})
              .finally(() => {
                active--;
                statusEl.textContent = 'Preloading game files… ' + Math.min(100, Math.floor(loaded * 100 / total)) +
                  '% (' + (Math.min(loaded, total) / 1048576 | 0) + ' / ' + (total / 1048576 | 0) + ' MB)';
                if ((loaded >= PRELOAD_BYTES || next >= queue.length) && active === 0) finish(); else pump();
              });
          }
          if (active === 0 && (loaded >= PRELOAD_BYTES || next >= queue.length)) finish();
        };
        statusEl.textContent = 'Preloading game files… 0%';
        pump();
      }
      append('Mounted ' + files.length + ' game files from the server' + (table ? ' (read on the calling thread)' : ''));
      // A few seconds' head start for the boot's own reads before the copy competes for the disk.
      if (OPFS) setTimeout(() => startOpfsCopy(files), opfsMode === 'clear' ? 0 : 5000);
    }

    globalThis.LibertyGameFS = { mount: mountGameFiles, shared, opfs: opfsStatus };
})();

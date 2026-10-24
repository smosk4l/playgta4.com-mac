// Page bootstrap: checks the browser, then starts the engine (liberty.js / liberty.wasm).
'use strict';

(function () {
	const statusEl = document.getElementById('boot-status');
	const progressEl = document.getElementById('boot-progress');
	const checksEl = document.getElementById('boot-checks');
	const params = new URLSearchParams(location.search);
	let nativeFatal = '';

	function status(text, pct) {
		statusEl.textContent = text;
		if (pct !== undefined) progressEl.style.width = pct + '%';
	}

	function fatal(title, message) {
		document.getElementById('fatal-title').textContent = title;
		document.getElementById('fatal-message').textContent = nativeFatal || message;
		document.getElementById('fatal').hidden = false;
		document.getElementById('boot').classList.add('boot-hidden');
	}

	function log(line, isError) {
		line = String(line);
		if (isError) console.warn(line);
		if (line.includes('[FATAL]')) {
			nativeFatal = line;
			fatal('The engine aborted', line);
		}
	}
	const fullscreenButton = document.getElementById('fullscreen');
	function toggleFullscreen() {
		const action = document.fullscreenElement ? document.exitFullscreen() :
			document.documentElement.requestFullscreen();
		action.catch((error) => log('Fullscreen failed: ' + error.message, true));
	}
	fullscreenButton?.addEventListener('click', toggleFullscreen);
	document.addEventListener('fullscreenchange', () => {
		if (fullscreenButton) fullscreenButton.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
	});
	window.addEventListener('keydown', (event) => {
		if (event.altKey && event.key === 'Enter') {
			event.preventDefault();
			event.stopImmediatePropagation();
			toggleFullscreen();
			return;
		}
	}, true);

	function memory64Supported() {
		try {
			new WebAssembly.Memory({ initial: 1, maximum: 2, index: 'i64' });
			return true;
		} catch (e) {
			return false;
		}
	}

	const checks = [
		['Cross-origin isolation (threads)', self.crossOriginIsolated === true,
			'Open the page through web/server.js; it sends the COOP/COEP headers.'],
		['SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined', 'Requires cross-origin isolation.'],
		['WebAssembly memory64', memory64Supported(), 'Use a current Chrome, Edge or Firefox.'],
		['WebGPU', !!navigator.gpu, 'Use a current Chrome or Edge (or enable WebGPU).'],
	];
	let ok = true;
	for (const [name, passed, hint] of checks) {
		const li = document.createElement('li');
		li.className = passed ? 'ok' : 'bad';
		li.textContent = (passed ? '✓ ' : '✗ ') + name + (passed ? '' : ' — ' + hint);
		checksEl.appendChild(li);
		ok = ok && passed;
	}
	if (!ok && params.get('force') !== '1') {
		status('This browser cannot run the game (see above). Add ?force=1 to try anyway.');
		return;
	}


    const append = (line) => log(line, false);
    const configure = function configure(search) {
  const params = new URLSearchParams(search);
  // Keep the packaged app's args= syntax; repeated native arg= values win.
  const args = (params.get('args') || '').split(/\s+/).filter(Boolean).concat(params.getAll('arg'));
  const has = name => args.some(arg => arg === '--' + name || arg.startsWith('--' + name + '='));
  const add = (name, value) => { if (!has(name)) args.push('--' + name + '=' + value); };
  add('fullscreen', 'false');
  if (!has('video_mode_width') && !has('video_mode_height')) add('resolution', '720p');
  add('gta4_aspect_ratio', '16:9');
  add('gta4_reflection_resolution', 'original');
  add('gta4_shadow_map_base_size', '256');
  add('gta4_shadow_distance_scale', '1');
  add('gta4_draw_distance_scale', '1');
  // All draw inputs are captured before this native acknowledgment. The
  // existing present/GPU limits still bound queued work and buffer reuse.
  add('webgpu_early_frame_ack', 'true');
  add('saved_game_root', '/data/LibertyRecomp/saves');
  // Keep diagnostics disabled, including when an old bookmarked URL enables them.
  const diagnostics = {
   diagnostics: 'false', diagnostics_categories: '', webgpu_perf_report: 'false',
   webgpu_gpu_timing: 'false', webgpu_trace_frame: '0', webgpu_trace_pixel: '',
   gta4_transition_diagnostics: 'off', log_level: 'error',
  };
  for (const [name, value] of Object.entries(diagnostics)) {
   for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--' + name || args[i].startsWith('--' + name + '=')) args.splice(i, 1);
   }
   if (value !== '') args.push('--' + name + '=' + value);
  }
  return args;
 };

    function mountGameFiles() {
      const probe = new XMLHttpRequest();
      probe.open('GET', '/game/index.json', false);
      try { probe.send(); } catch (e) { return; }
      if (probe.status !== 200) return;
      const files = JSON.parse(probe.responseText).files;
      const root = '/data/LibertyRecomp/game';
      ENV.XDG_DATA_HOME = '/data';
      const CHUNK = 4 << 20;
      // ?preload=1 / ?preload=0 override the hostname check, e.g. for an SSH
      // tunnel, where the browser sees localhost but the data crosses a network.
      const forced = new URLSearchParams(location.search).get('preload');
      const REMOTE = forced === '1' ? true : forced === '0' ? false
        : !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      // Remote visitors preload PRELOAD_BYTES before the game starts; the cache
      // has to hold all of it, with headroom for read-ahead.
      const PRELOAD_BYTES = 500 << 20, MAX_CACHED = REMOTE ? PRELOAD_BYTES / CHUNK + 32 : 128;
      // Reads block the title, so over a slow link every uncached chunk stalls
      // the game (and its clocks) for a full round trip. After each read, fetch
      // the next chunks asynchronously so later reads hit the cache.
      // Local reads are fast enough that this would only add load, so it is
      // skipped on loopback.
      const READ_AHEAD = REMOTE ? 3 : 0, MAX_PENDING = 4;
      const cache = new Map();
      const pending = new Set();
      const remember = (key, bytes) => {
        cache.set(key, bytes);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      };
      const prefetchChunk = (url, index, size) => {
        const key = url + '#' + index;
        if (index * CHUNK >= size || cache.has(key) || pending.has(key) || pending.size >= MAX_PENDING) return;
        pending.add(key);
        const start = index * CHUNK, end = Math.min(size, start + CHUNK) - 1;
        fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
          .then((r) => (r.status === 206 || r.status === 200) ? r.arrayBuffer() : null)
          .then((buf) => { if (buf && !cache.has(key)) remember(key, new Uint8Array(buf)); })
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
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        xhr.send();
        if (xhr.status !== 206 && xhr.status !== 200) throw new FS.ErrnoError(5);
        const text = xhr.responseText;
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        remember(key, bytes);
        return bytes;
      };
      for (const [path, size] of files) {
        const slash = path.lastIndexOf('/');
        const dir = root + (slash >= 0 ? '/' + path.slice(0, slash) : '');
        FS.mkdirTree(dir);
        const node = FS.createFile(dir, path.slice(slash + 1), null, true, false);
        const url = '/game/' + path.split('/').map(encodeURIComponent).join('/');
        node.usedBytes = size;
        node.stream_ops = Object.assign({}, node.stream_ops, {
          read(stream, buffer, offset, length, position) {
            if (position >= size) return 0;
            length = Math.min(length, size - position);
            let done = 0;
            while (done < length) {
              const at = position + done, index = Math.floor(at / CHUNK);
              const chunk = fetchChunk(url, index, size);
              const from = at - index * CHUNK, n = Math.min(length - done, chunk.length - from);
              buffer.set(chunk.subarray(from, from + n), offset + done);
              done += n;
            }
            return done;
          },
          // The title maps files (default.xex, the disc images) rather than
          // reading them; copy the mapped range in like MEMFS does.
          mmap(stream, length, position) {
            const ptr = mmapAlloc(length);
            node.stream_ops.read(stream, HEAP8, ptr, length, position);
            return { ptr, allocated: true };
          },
        });
      }
      // Remote devices download the first PRELOAD_BYTES before the game starts
      // (run dependency holds main() back): the files the opening reads first,
      // then the rest in manifest order. Local access skips this.
      if (REMOTE) {
        const sizes = new Map(files);
        const urlOf = (path) => '/game/' + path.split('/').map(encodeURIComponent).join('/');
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
            const url = urlOf(path), size = sizes.get(path);
            const start = index * CHUNK, end = Math.min(size, start + CHUNK) - 1;
            active++;
            fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
              .then((r) => (r.status === 206 || r.status === 200) ? r.arrayBuffer() : null)
              .then((buf) => {
                if (!buf) return;
                if (!cache.has(url + '#' + index)) remember(url + '#' + index, new Uint8Array(buf));
                loaded += buf.byteLength;
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
      append('Mounted ' + files.length + ' game files from the server');
    }

    const SAVE_ROOT = '/data/LibertyRecomp/saves';
    const DB_NAME = 'LibertyRecompSaves';
    const STORE_NAME = 'saves';

    function openSaveDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'relPath' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function collectCurrentSaves() {
      const items = [];
      function scan(dir) {
        let entries;
        try {
          entries = FS.readdir(dir);
        } catch (e) {
          return;
        }
        for (const name of entries) {
          if (name === '.' || name === '..') continue;
          const fullPath = (dir === '/' ? '' : dir) + '/' + name;
          try {
            const stat = FS.stat(fullPath);
            const relPath = fullPath.slice(SAVE_ROOT.length).replace(/^\/+/, '');
            if (!relPath) continue;
            if (FS.isDir(stat.mode)) {
              items.push({
                relPath,
                isDir: true,
                mode: stat.mode,
                mtime: stat.mtime instanceof Date ? stat.mtime.getTime() : (stat.mtime || Date.now())
              });
              scan(fullPath);
            } else if (FS.isFile(stat.mode)) {
              const contents = FS.readFile(fullPath);
              items.push({
                relPath,
                isDir: false,
                mode: stat.mode,
                mtime: stat.mtime instanceof Date ? stat.mtime.getTime() : (stat.mtime || Date.now()),
                contents: new Uint8Array(contents)
              });
            }
          } catch (e) {
            console.warn('[saves] Error scanning:', fullPath, e);
          }
        }
      }
      scan(SAVE_ROOT);
      return items;
    }

    let isPersisting = false;
    let pendingPersist = false;

    async function persistSavesToIndexedDB() {
      if (isPersisting) {
        pendingPersist = true;
        return;
      }
      isPersisting = true;
      pendingPersist = false;
      try {
        const items = collectCurrentSaves();
        if (!items.length) {
          isPersisting = false;
          return;
        }
        const db = await openSaveDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);

          const keysReq = store.getAllKeys();
          keysReq.onsuccess = () => {
            const oldKeys = new Set(keysReq.result || []);
            const currentKeys = new Set();

            for (const item of items) {
              currentKeys.add(item.relPath);
              store.put(item);
            }

            for (const k of oldKeys) {
              if (!currentKeys.has(k)) {
                store.delete(k);
              }
            }
          };

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        const fileCount = items.filter(x => !x.isDir).length;
        append('[saves] Persisted ' + fileCount + ' save files to browser storage');
      } catch (err) {
        console.warn('[saves] Persist failed:', err);
      } finally {
        isPersisting = false;
        if (pendingPersist) {
          persistSavesToIndexedDB();
        }
      }
    }

    let saveSyncTimer = null;
    function scheduleSaveSync(delayMs = 250) {
      if (saveSyncTimer) clearTimeout(saveSyncTimer);
      saveSyncTimer = setTimeout(() => {
        saveSyncTimer = null;
        persistSavesToIndexedDB();
      }, delayMs);
    }

    async function restoreSavesFromIndexedDB() {
      let db;
      try {
        db = await openSaveDB();
      } catch (e) {
        console.warn('[saves] Cannot open IndexedDB for restore:', e);
        return;
      }
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const records = req.result || [];
          if (!records.length) {
            append('[saves] No existing saves found in browser storage');
            return resolve();
          }
          records.sort((a, b) => a.relPath.localeCompare(b.relPath));
          let restoredCount = 0;
          for (const rec of records) {
            const fullPath = SAVE_ROOT + '/' + rec.relPath;
            try {
              if (rec.isDir) {
                FS.mkdirTree(fullPath);
              } else {
                const slash = fullPath.lastIndexOf('/');
                if (slash >= 0) FS.mkdirTree(fullPath.slice(0, slash));
                FS.writeFile(fullPath, rec.contents);
                if (rec.mode) {
                  try { FS.chmod(fullPath, rec.mode); } catch (e) {}
                }
                if (rec.mtime) {
                  try { FS.utime(fullPath, rec.mtime, rec.mtime); } catch (e) {}
                }
                restoredCount++;
              }
            } catch (e) {
              console.warn('[saves] Error restoring:', fullPath, e);
            }
          }
          append('[saves] Restored ' + restoredCount + ' save files from browser storage');
          resolve();
        };
        req.onerror = () => {
          console.warn('[saves] Error fetching saves from IndexedDB:', req.error);
          resolve();
        };
      });
    }

    const SaveFilesystem = {
      mount(mount) {
        return (FS.filesystems?.MEMFS || MEMFS).mount(mount);
      },
      syncfs(mount, populate, callback) {
        if (populate) {
          restoreSavesFromIndexedDB().then(() => callback(null)).catch((e) => callback(e || 1));
        } else {
          persistSavesToIndexedDB().then(() => callback(null)).catch((e) => callback(e || 1));
        }
      }
    };

    function setupSavePersistence() {
      addRunDependency('restore-saves');
      try {
        FS.filesystems.IDBFS = SaveFilesystem;
        FS.mkdirTree(SAVE_ROOT);
        FS.mount(SaveFilesystem, {}, SAVE_ROOT);
      } catch (e) {
        console.warn('[saves] Mount setup notice:', e.message);
      }

      if (!FS._savesHooked) {
        FS._savesHooked = true;
        const isSavePath = (p) => typeof p === 'string' && p.startsWith(SAVE_ROOT);

        const origClose = FS.close;
        FS.close = function (stream) {
          const res = origClose.apply(this, arguments);
          try {
            const path = stream?.node ? FS.getPath(stream.node) : '';
            if (isSavePath(path)) scheduleSaveSync(200);
          } catch (e) {}
          return res;
        };

        const origRename = FS.rename;
        FS.rename = function (oldPath, newPath) {
          const res = origRename.apply(this, arguments);
          try {
            if (isSavePath(oldPath) || isSavePath(newPath)) scheduleSaveSync(200);
          } catch (e) {}
          return res;
        };

        const origUnlink = FS.unlink;
        FS.unlink = function (path) {
          const res = origUnlink.apply(this, arguments);
          try {
            if (isSavePath(path)) scheduleSaveSync(200);
          } catch (e) {}
          return res;
        };

        const origRmdir = FS.rmdir;
        FS.rmdir = function (path) {
          const res = origRmdir.apply(this, arguments);
          try {
            if (isSavePath(path)) scheduleSaveSync(200);
          } catch (e) {}
          return res;
        };

        window.addEventListener('beforeunload', () => persistSavesToIndexedDB());
        window.addEventListener('pagehide', () => persistSavesToIndexedDB());
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') persistSavesToIndexedDB();
        });
        setInterval(() => scheduleSaveSync(0), 5000);
      }

      restoreSavesFromIndexedDB()
        .catch((err) => console.error('[saves] Restore failed:', err))
        .finally(() => {
          removeRunDependency('restore-saves');
        });
    }

    window.exportSaves = async function () {
      await persistSavesToIndexedDB();
      const db = await openSaveDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const records = req.result || [];
          const payload = records.map(r => ({
            relPath: r.relPath,
            isDir: r.isDir,
            mode: r.mode,
            mtime: r.mtime,
            contents: r.contents ? Array.from(r.contents) : null
          }));
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'gta4_saves_backup.json';
          a.click();
          URL.revokeObjectURL(url);
          resolve(payload.length);
        };
        req.onerror = () => reject(req.error);
      });
    };

    window.importSaves = async function (jsonInput) {
      if (!jsonInput) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (file) {
            const text = await file.text();
            await window.importSaves(text);
            alert('Save files imported successfully! Reload to apply if needed.');
          }
        };
        input.click();
        return;
      }
      let data;
      if (typeof jsonInput === 'string') {
        data = JSON.parse(jsonInput);
      } else {
        data = jsonInput;
      }
      const db = await openSaveDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const item of data) {
          store.put({
            relPath: item.relPath,
            isDir: item.isDir,
            mode: item.mode,
            mtime: item.mtime,
            contents: item.contents ? new Uint8Array(item.contents) : undefined
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      if (typeof FS !== 'undefined') {
        await restoreSavesFromIndexedDB();
      }
      console.log('[saves] Successfully imported ' + data.length + ' save entries');
    };

    const input = document.getElementById('canvas');
    for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
      input[name] = (options) => (document.documentElement.requestFullscreen ||
        document.documentElement.webkitRequestFullscreen).call(document.documentElement, options);
    }
    status('Downloading the engine…', 10);
    window.Module = {
      canvas: input,
      arguments: configure(location.search),
      print: (text) => log(text, false),
      printErr: (text) => log(text, true),
      setStatus: (text) => { if (text) status(text); },
      preRun: [mountGameFiles, setupSavePersistence],
      onRuntimeInitialized: () => {
        status('Running', 100);
        document.getElementById('boot').classList.add('boot-hidden');
        input.focus();
      },
      onAbort: (what) => fatal('The engine aborted', String(what || 'Reload the page to try again.')),
      onExit: (code) => { if (code) fatal('The engine exited', 'exit code ' + code); },
    };
    const script = document.createElement('script');
    script.src = 'liberty.js';
    script.onerror = () => fatal('Engine missing', 'Could not load liberty.js.');
    document.body.appendChild(script);
})();

// Page bootstrap: checks the browser, then starts the engine (liberty.js / liberty.wasm).
'use strict';

(function () {
	const statusEl = document.getElementById('boot-status');
	const progressEl = document.getElementById('boot-progress');
	const checksEl = document.getElementById('boot-checks');
	const params = new URLSearchParams(location.search);
	let nativeFatal = '';
	// ?perf= / ?loglevel= are diagnostic runs: show the engine's stdout in the console too.
	const verbose = params.has('loglevel') || (params.get('perf') || '0') !== '0';

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
		else if (verbose) console.log(line);
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
	// gamefs.js and saves.js log through the same filter as the engine (and gamefs.js reports a missing index).
	globalThis.LibertyBoot = { log, fatal };
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
  // Playability tweaks (tweaks.js, app/tweaks/*.js) go first so they override the defaults below.
  globalThis.LibertyTweaks?.apply({ params, add, has });
  add('fullscreen', 'false');
  // Render at the screen's pixel size (16:9, capped at 1440p) instead of upscaling 720p. The title is
  // CPU-bound, so the extra pixels cost little; ?res=720p (or any --resolution preset) restores the old size.
  if (!has('video_mode_width') && !has('video_mode_height') && !has('resolution')) {
   if (params.get('res')) add('resolution', params.get('res'));
   else {
    const scale = Math.min(innerWidth * devicePixelRatio / 16, innerHeight * devicePixelRatio / 9, 160);
    // tweaks/fixes.js snaps the size to one the renderer's exposure chain handles (?exposurefix=off).
    if (globalThis.libertyAddVideoMode) globalThis.libertyAddVideoMode(add, scale);
    else {
     add('video_mode_width', 2 * Math.round(scale * 8));
     add('video_mode_height', 2 * Math.round(scale * 4.5));
    }
   }
  }
  // Caps the game simulation as well as presentation (0 unlocks; 30, 40, 60 and 120 are accepted).
  // Uncapped rates above 60 (e.g. on 120 Hz displays) are the suspected cause of too-fast vehicles;
  // ?fpslimit=30 matches the original console cap.
  add('gta4_frame_limit', params.get('fpslimit') || '60');
  // Native keyboard/mouse (LMB attack/fire, RMB aim). Touch controls default to 'auto', which treats
  // browser pointer events as touches and can swallow mouse clicks; ?touch=1 brings them back.
  // Skip the publisher logo movies at startup (?intro=1 plays them).
  add('gta4_skip_intro', params.get('intro') === '1' ? 'false' : 'true');
  add('mnk_mode', 'true');
  add('touch_controls', params.get('touch') === '1' ? 'on' : 'off');
  add('gta4_aspect_ratio', '16:9');
  add('gta4_reflection_resolution', 'original');
  add('gta4_shadow_map_base_size', '256');
  add('gta4_shadow_distance_scale', '1');
  add('gta4_draw_distance_scale', '1');
  // All draw inputs are captured before this native acknowledgment. The
  // existing present/GPU limits still bound queued work and buffer reuse.
  add('webgpu_early_frame_ack', 'true');
  add('saved_game_root', '/data/LibertyRecomp/saves');
  // Keep diagnostics disabled, including when an old bookmarked URL enables them. ?perf=1 logs the
  // renderer's stage timings and sampled guest CPU hot spots to the console every 5 s; ?perf=2 adds GPU pass timing (costs frames).
  const perf = params.get('perf') || '0';
  const diagnostics = {
   diagnostics: 'false', diagnostics_categories: '', webgpu_perf_report: perf !== '0' ? 'true' : 'false',
   webgpu_gpu_timing: perf === '2' ? 'true' : 'false', webgpu_trace_frame: '0', webgpu_trace_pixel: '',
   gta4_transition_diagnostics: 'off', log_level: params.get('loglevel') || (perf !== '0' ? 'warn' : 'error'),
   web_cpu_profile: perf !== '0' ? 'true' : 'false',
  };
  for (const [name, value] of Object.entries(diagnostics)) {
   for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--' + name || args[i].startsWith('--' + name + '=')) args.splice(i, 1);
   }
   if (value !== '') args.push('--' + name + '=' + value);
  }
  return args;
 };

    // Play through the AudioWorklet ring in audio_output.js instead of SDL's ScriptProcessorNode,
    // which runs on the page thread and drops out whenever that thread stalls.
    function setupAudioOutput() {
      // AudioWorklet playback by default; ?audio=sdl keeps SDL's ScriptProcessorNode path.
      if (!window.LibertyAudioOutput || params.get('audio') === 'sdl') return;
      addRunDependency('audio-output');
      LibertyAudioOutput.prepare(Module)
        .catch((error) => console.warn('AudioWorklet setup failed; using SDL playback:', error))
        .finally(() => removeRunDependency('audio-output'));
      // SDL only auto-resumes contexts it creates itself; browsers start this one suspended.
      const resume = () => {
        const context = Module.SDL3 && Module.SDL3.audioContext;
        if (context && context.state === 'suspended') context.resume();
      };
      for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, resume, true);
    }

    // Mute the game while this window is unfocused or hidden (?bgaudio=1 keeps it playing). Every
    // connection to a context's destination goes through one gain node per context, so muting never
    // suspends the context or stalls the engine's audio callback.
    if (params.get('bgaudio') !== '1') {
      const masters = new WeakMap();
      const audible = () => document.visibilityState === 'visible' && document.hasFocus();
      const masterFor = (context) => {
        let gain = masters.get(context);
        if (!gain) {
          gain = context.createGain();
          gain.gain.value = audible() ? 1 : 0;
          connect.call(gain, context.destination);
          masters.set(context, gain);
          contexts.add(context);
        }
        return gain;
      };
      const contexts = new Set();
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (destination, ...rest) {
        if (destination instanceof AudioDestinationNode) destination = masterFor(destination.context);
        return connect.call(this, destination, ...rest);
      };
      const update = () => {
        for (const context of contexts) masters.get(context).gain.setTargetAtTime(audible() ? 1 : 0, context.currentTime, 0.02);
      };
      for (const type of ['focus', 'blur']) window.addEventListener(type, update);
      document.addEventListener('visibilitychange', update);
    }

    const input = document.getElementById('canvas');
    for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
      input[name] = (options) => (document.documentElement.requestFullscreen ||
        document.documentElement.webkitRequestFullscreen).call(document.documentElement, options);
    }
    // Frame rate from the render thread (see the liberty-fps channel in liberty.js); ?fps=0 hides the counter.
    window.gpuStats = null;
    const fpsEl = params.get('fps') !== '0' ? document.body.appendChild(document.createElement('div')) : null;
    if (fpsEl) fpsEl.id = 'fps';
    new BroadcastChannel('liberty-fps').onmessage = (event) => {
      window.gpuStats = event.data;
      if (fpsEl) fpsEl.textContent = Math.round(event.data.fps) + ' FPS';
    };
    status('Downloading the engine…', 10);
    window.Module = {
      canvas: input,
      arguments: configure(location.search),
      print: (text) => log(text, false),
      printErr: (text) => log(text, true),
      setStatus: (text) => { if (text) status(text); },
      preRun: [LibertyGameFS.mount, LibertySaves.setup, setupAudioOutput],
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

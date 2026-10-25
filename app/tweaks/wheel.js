// Wheel quantizer: turns smooth/momentum wheel input (macOS + Logitech free-spin or thumb
// wheel, trackpads) into discrete notches, so one flick cycles one weapon instead of several.
//
// The engine listens via emscripten_set_wheel_callback("#canvas") (bubble phase, no isTrusted
// check) and SDL scales pixel-mode deltas by 1/100, so a synthetic deltaY of ±100 with
// deltaMode 0 is exactly one game-level step. Raw events headed for the canvas are swallowed
// here in the window capture phase and replaced by at most one such notch per accumulated
// threshold, rate-limited by a cooldown.
//
// Settings (URL > localStorage > fallback, see tweaks.js):
//   ?wheel=notch|gesture|raw  notch (default): one step per threshold, at most every cooldown ms
//                             gesture: one step per continuous scroll gesture; raw: untouched
//   ?wheelcooldown=120        minimum ms between emitted steps
//   ?wheelthreshold=10        accumulated pixels needed for a step
//   ?wheelgap=180             ms of silence that ends a gesture (and resets the accumulator)
'use strict';

(function () {
	const setting = globalThis.LibertyTweaks?.setting ?? ((name, fallback) => fallback);
	const mode = String(setting('wheel', 'notch')).toLowerCase();
	if (mode === 'raw' || mode === 'off') return;

	function number(name, fallback, min) {
		const value = Number(setting(name, String(fallback)));
		return Number.isFinite(value) && value >= min ? value : fallback;
	}
	const cooldown = number('wheelcooldown', 120, 0);
	const threshold = number('wheelthreshold', 10, 0.01);
	const gap = number('wheelgap', 180, 1);
	const STEP = 100; // pixels per engine step (SDL divides deltaMode 0 by 100)

	// Normalizes to the engine's pixel scale: lines are /3 per step, pages *80 per step.
	function pixels(delta, deltaMode) {
		if (deltaMode === 1) return delta * STEP / 3;
		if (deltaMode === 2) return delta * STEP * 80;
		return delta;
	}

	// One accumulator per axis. feed() returns -1, 0 or 1 (the notch to emit).
	function axis() {
		let sum = 0;
		let lastInput = -Infinity;
		let lastEmit = -Infinity;
		let direction = 0;
		let fired = false; // gesture mode: already emitted during this gesture
		return function feed(delta, now) {
			if (now - lastInput > gap) {
				sum = 0;
				direction = 0;
				fired = false;
			}
			lastInput = now;
			if (!delta) return 0;
			if (direction && Math.sign(delta) !== direction) {
				// Reversal: start over, and let a deliberate change of direction through.
				sum = 0;
				fired = false;
				lastEmit = -Infinity;
			}
			direction = Math.sign(delta);
			sum += delta;
			if (Math.abs(sum) < threshold) return 0;
			if (mode === 'gesture' && fired) return 0;
			if (now - lastEmit < cooldown) {
				sum = Math.sign(sum) * threshold; // keep it armed, but don't stack momentum
				return 0;
			}
			const notch = Math.sign(sum);
			sum = 0;
			lastEmit = now;
			fired = true;
			return notch;
		};
	}
	const feedX = axis();
	const feedY = axis();
	const synthetic = new WeakSet();
	let canvas = null;

	function headedForCanvas(event) {
		canvas ||= document.getElementById('canvas');
		return !!canvas && (event.target === canvas || document.pointerLockElement === canvas);
	}

	window.addEventListener('wheel', (event) => {
		if (synthetic.has(event) || event.ctrlKey || !headedForCanvas(event)) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		const now = event.timeStamp || performance.now();
		const x = feedX(pixels(event.deltaX, event.deltaMode), now);
		const y = feedY(pixels(event.deltaY, event.deltaMode), now);
		if (!x && !y) return;
		const notch = new WheelEvent('wheel', {
			deltaX: x * STEP,
			deltaY: y * STEP,
			deltaZ: 0,
			deltaMode: 0,
			bubbles: true,
			cancelable: true,
			composed: true,
			view: window,
			screenX: event.screenX,
			screenY: event.screenY,
			clientX: event.clientX,
			clientY: event.clientY,
			movementX: 0,
			movementY: 0,
			button: event.button,
			buttons: event.buttons,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
		});
		synthetic.add(notch);
		event.target.dispatchEvent(notch);
	}, { capture: true, passive: false });
})();

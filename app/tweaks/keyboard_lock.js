// Keyboard Lock while fullscreen: lets a short Esc press reach the game (GTA's pause menu)
// instead of Chrome exiting pointer lock / fullscreen. Holding Esc (~2 s) still leaves
// fullscreen, which is the browser's built-in escape hatch and cannot be overridden.
// Keyboard Lock only takes effect in JS-initiated fullscreen (Alt+Enter / the button),
// not in the browser's own fullscreen (View > Enter Full Screen / Ctrl+Cmd+F).
// ?kblock=on (default: Esc, Tab, F-keys) | all (every key the OS lets the browser capture,
// including Cmd+W/Cmd+T/Cmd+L style shortcuts) | off. Cmd+Q and Cmd+Tab are never capturable.
'use strict';

(function () {
	const mode = globalThis.LibertyTweaks?.setting('kblock', 'on') ?? 'on';
	const keyboard = navigator.keyboard;
	if (mode === 'off' || typeof keyboard?.lock !== 'function') return;

	const keys = ['Escape', 'Tab'];
	for (let i = 1; i <= 12; i++) keys.push('F' + i);

	let locked = false;

	function lock() {
		const request = mode === 'all' ? keyboard.lock() : keyboard.lock(keys);
		request.then(() => {
			locked = true;
			if (!document.fullscreenElement) unlock(); // Left fullscreen before the lock settled.
		}, (error) => {
			console.warn('Keyboard lock failed: ' + error.message);
		});
	}

	function unlock() {
		if (!locked) return;
		locked = false;
		try {
			keyboard.unlock();
		} catch (e) {
			// Nothing to release.
		}
	}

	document.addEventListener('fullscreenchange', () => {
		if (document.fullscreenElement) lock();
		else unlock();
	});

	// Locked keys are delivered to the page, so stop the browser's default actions for them
	// (Tab focus navigation, F-key shortcuts) while fullscreen; the engine still sees the event.
	window.addEventListener('keydown', (event) => {
		if (!locked || !document.fullscreenElement) return;
		if (event.code === 'Tab' || /^F([1-9]|1[0-2])$/.test(event.code)) event.preventDefault();
	});
})();

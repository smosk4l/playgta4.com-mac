// Auto fullscreen: the first click on the game also enters page fullscreen (no tabs, address
// bar or macOS menu bar), so keyboard_lock.js can route a short Esc to the game. Leaving
// fullscreen (hold Esc) is respected until the next click on the game; ⌥+Return still toggles.
// ?autofs=on (default) | off.
'use strict';

(function () {
	const mode = globalThis.LibertyTweaks?.setting('autofs', 'on') ?? 'on';
	if (mode === 'off' || mode === '0' || mode === 'false') return;
	const root = document.documentElement;
	if (typeof root.requestFullscreen !== 'function') return;

	window.addEventListener('pointerdown', (event) => {
		if (document.fullscreenElement || event.button !== 0) return;
		const canvas = document.getElementById('canvas');
		if (!canvas || event.target !== canvas) return;
		root.requestFullscreen({ navigationUI: 'hide' }).then(() => {
			// Entering fullscreen consumes the click's user activation, so take pointer lock
			// here in case the engine's own request from the same click was refused.
			if (document.pointerLockElement !== canvas) {
				const request = canvas.requestPointerLock();
				request?.catch?.(() => {});
			}
		}, (error) => {
			console.warn('Auto fullscreen failed: ' + error.message);
		});
	}, true);
})();

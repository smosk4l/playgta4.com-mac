// Navigation guard: keeps an accidental "go back" from killing the running game.
// - Mouse back/forward side buttons (MouseEvent.button 3/4): Chrome navigates history on
//   mouseup unless the page cancels it. We only preventDefault (capture phase on window) and
//   never stopPropagation, so SDL still sees the buttons as X1/X2 through its own listeners.
// - Two-finger trackpad swipe back/forward: overscroll-behavior-x: none on the root disables
//   Chrome's history swipe gesture.
// - Cmd+W / Cmd+R / anything else that unloads: a beforeunload prompt once the game is running.
// Disable with ?navguard=off (remembered; ?navguard=default forgets it).
'use strict';

(function () {
	const tweaks = globalThis.LibertyTweaks;
	const enabled = tweaks ? tweaks.setting('navguard', 'on') !== 'off' : true;
	if (!enabled) return;

	const BACK = 3;
	const FORWARD = 4;

	function blockSideButton(event) {
		if (event.button === BACK || event.button === FORWARD) event.preventDefault();
	}

	// mouseup is what Chrome checks before navigating; auxclick and mousedown cover other
	// browsers / older Chrome builds. pointerup is cancelled too because Blink reports the
	// mouse-up as handled if either the pointer or the compatibility mouse event was cancelled.
	// pointerdown is deliberately left alone: cancelling it suppresses the compatibility
	// mousedown/mouseup events that SDL's button tracking relies on.
	for (const type of ['mousedown', 'mouseup', 'auxclick', 'pointerup']) {
		window.addEventListener(type, blockSideButton, { capture: true });
	}

	// Disable the trackpad history swipe (the page never scrolls horizontally anyway).
	document.documentElement.style.overscrollBehaviorX = 'none';
	if (document.body) document.body.style.overscrollBehaviorX = 'none';
	else document.addEventListener('DOMContentLoaded', () => { document.body.style.overscrollBehaviorX = 'none'; });

	// The game counts as running once boot.js hid the splash and no fatal screen is shown.
	function gameRunning() {
		const boot = document.getElementById('boot');
		const fatal = document.getElementById('fatal');
		if (!boot || !boot.classList.contains('boot-hidden')) return false;
		return !fatal || fatal.hidden;
	}

	// saves.js may also cancel beforeunload while a save is uploading; Chrome shows a single
	// dialog per navigation however many handlers cancel it, so the prompts never stack.
	window.addEventListener('beforeunload', (event) => {
		if (!gameRunning()) return;
		event.preventDefault();
		event.returnValue = '';
	});
})();

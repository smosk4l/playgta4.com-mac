// Chorded mouse buttons: browsers send pointerdown/pointerup only for the first button pressed and
// the last one released. Any other press or release (LMB while RMB is held to aim) arrives as a
// pointermove whose `button` names the changed button. SDL's pointer handler (liberty.js) only
// passes `button` plus down = (type == 'pointerdown'), so it drops that press or reads it as a
// release. Re-dispatch those changes as real pointerdown/pointerup events. ?chords=off disables.
'use strict';

(function () {
	const mode = globalThis.LibertyTweaks ? LibertyTweaks.setting('chords', 'on') : 'on';
	if (mode === 'off') return;

	// PointerEvent.button -> its bit in PointerEvent.buttons.
	const BUTTON_BITS = [1, 4, 2, 8, 16];
	const synthetic = new WeakSet();

	window.addEventListener('pointermove', (event) => {
		if (synthetic.has(event) || event.pointerType !== 'mouse') return;
		const bit = BUTTON_BITS[event.button];
		if (!bit) return; // button -1: plain movement
		const pressed = (event.buttons & bit) !== 0;
		const replacement = new PointerEvent(pressed ? 'pointerdown' : 'pointerup', {
			bubbles: true, cancelable: true, composed: true,
			pointerId: event.pointerId, pointerType: 'mouse', isPrimary: event.isPrimary,
			button: event.button, buttons: event.buttons,
			clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
			movementX: event.movementX, movementY: event.movementY,
			ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
		});
		synthetic.add(replacement);
		event.stopImmediatePropagation();
		event.target.dispatchEvent(replacement);
	}, true);
})();

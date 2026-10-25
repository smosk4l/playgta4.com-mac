// Raw mouse: asks pointer lock for unadjusted movement so OS pointer acceleration
// (macOS especially) does not distort aiming. ?rawmouse=off disables it.
// The engine calls element.requestPointerLock() with no options (Emscripten's
// requestPointerLock helper and Browser's canvas click/fullscreen handlers), so the
// prototype method is wrapped to add { unadjustedMovement: true }. If the platform
// rejects that with NotSupportedError, the call is retried once without options and
// the wrapper stops asking for raw input for the rest of the session.
'use strict';

(function () {
	const tweaks = globalThis.LibertyTweaks;
	const enabled = tweaks ? tweaks.setting('rawmouse', 'on') : 'on';
	if (enabled === 'off' || enabled === '0' || enabled === 'false') return;
	if (typeof Element === 'undefined' || !Element.prototype.requestPointerLock) return;

	const original = Element.prototype.requestPointerLock;
	let supported = true;

	function isNotSupported(error) {
		return !!error && error.name === 'NotSupportedError';
	}

	function giveUp(error) {
		if (!supported) return;
		supported = false;
		console.warn('Raw mouse input unavailable, using accelerated pointer lock:', error && error.message);
	}

	function requestPointerLock(options) {
		// Callers that pass their own options, or a platform known not to support raw
		// input, get the native behaviour unchanged.
		if (!supported || options !== undefined) return original.apply(this, arguments);

		let result;
		try {
			result = original.call(this, { unadjustedMovement: true });
		} catch (error) {
			// Some implementations throw synchronously instead of rejecting.
			if (!isNotSupported(error)) throw error;
			giveUp(error);
			return original.call(this);
		}

		// Older browsers return undefined and ignore the options; nothing to chain.
		if (!result || typeof result.then !== 'function') return result;

		// Fall back exactly once per call and only for NotSupportedError; other
		// rejections (no user gesture, re-lock too soon after exit) are passed through,
		// so an engine that re-locks on pointerlockchange cannot loop through us.
		return result.catch((error) => {
			if (!isNotSupported(error)) throw error;
			giveUp(error);
			return original.call(this);
		});
	}

	Element.prototype.requestPointerLock = requestPointerLock;
})();

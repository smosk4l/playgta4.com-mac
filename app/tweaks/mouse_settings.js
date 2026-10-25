// Mouse options the engine supports but boot.js never passes. Each one is only forwarded when the
// player set it (URL param, remembered in localStorage), so the engine defaults apply otherwise.
//   ?sens=0.5       --mnk_sensitivity (float, engine default 1.0, accepted range 0.01..10)
//   ?invert=on|off  --mnk_invert_y (bool, engine default false)
//   ?aimtoggle=on|off  --gta4_mouse_aim_toggle (bool, engine default false = hold RMB to aim)
// ?name=default forgets a remembered value. An explicit ?arg=--mnk_sensitivity=... still wins.
'use strict';

(function () {
	const tweaks = globalThis.LibertyTweaks;
	if (!tweaks) return;

	// The cvar registers range(0.01, 10); an out-of-range value is a CLI11 parse error, so clamp first.
	const SENS_MIN = 0.01;
	const SENS_MAX = 10;

	const ON = ['on', 'true', '1', 'yes'];
	const OFF = ['off', 'false', '0', 'no'];

	function bool(name, raw) {
		const value = String(raw).trim().toLowerCase();
		if (ON.includes(value)) return 'true';
		if (OFF.includes(value)) return 'false';
		console.warn('Ignoring ?' + name + '=' + raw + ' (expected on or off)');
		return null;
	}

	function sensitivity(raw) {
		const text = String(raw).trim();
		const value = Number(text);
		if (text === '' || !Number.isFinite(value)) {
			console.warn('Ignoring ?sens=' + raw + ' (expected a number, ' + SENS_MIN + '..' + SENS_MAX + ')');
			return null;
		}
		const clamped = Math.min(SENS_MAX, Math.max(SENS_MIN, value));
		if (clamped !== value) console.warn('?sens=' + raw + ' clamped to ' + clamped);
		return String(clamped);
	}

	tweaks.configure(function ({ add, setting }) {
		const sens = setting('sens', null);
		if (sens !== null) {
			const value = sensitivity(sens);
			if (value !== null) add('mnk_sensitivity', value);
		}

		const invert = setting('invert', null);
		if (invert !== null) {
			const value = bool('invert', invert);
			if (value !== null) add('mnk_invert_y', value);
		}

		const aimToggle = setting('aimtoggle', null);
		if (aimToggle !== null) {
			const value = bool('aimtoggle', aimToggle);
			if (value !== null) add('gta4_mouse_aim_toggle', value);
		}
	});
})();

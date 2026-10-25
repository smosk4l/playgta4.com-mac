// PC-style key layout. With mnk_mode the engine reads some PC keys itself (WASD driving, F enter,
// Space handbrake, number-row weapons, Up for the phone, mouse camera/aim) and also feeds the
// keybind_* keys in as Xbox 360 buttons. The stock keybind_* table is a pad layout (Space sprints,
// R jumps, Backspace punches), so this remaps those buttons to GTA IV PC keys. Each action can be
// changed with ?key_<action>=<Key> (remembered); ?controls=native keeps the engine's own table and
// ?controller=legacy switches to the engine's full Xbox controller translation.
'use strict';

(function () {
	// action -> [keybind_* suffix, PC default]. Key names are the engine parser's (LMB, RMB, MMB,
	// Mouse4, Mouse5, Shift, LeftCtrl, Space, Tab, Escape, Return, Up/Down/Left/Right, letters).
	const LAYOUT = {
		sprint: ['a', 'Shift'],
		jump: ['x', 'Space'],
		// B is the unarmed attack and also reload, so on R it matches the PC reload key and punches
		// when no gun is drawn. Move it with ?key_melee=Mouse4 for the MX Master thumb button.
		melee: ['b', 'R'],
		// The engine already enters/exits vehicles on F; keep the pad Y button off F so a press does
		// not toggle twice.
		enter: ['y', 'G'],
		cover: ['right_shoulder', 'Q'],
		action: ['left_shoulder', 'E'],
		crouch: ['lstick_press', 'C'],
		lookbehind: ['rstick_press', 'MMB'],
		camera: ['back', 'V'],
		phone: ['dpad_up', 'Up'],
		down: ['dpad_down', 'Down'],
		prevweapon: ['dpad_left', 'Left'],
		nextweapon: ['dpad_right', 'Right'],
		aim: ['left_trigger', 'RMB'],
		fire: ['right_trigger', 'LMB'],
		pause: ['start', 'Escape'],
	};

	LibertyTweaks.configure(({ add, setting }) => {
		if (setting('controller', 'native') === 'legacy') add('mnk_controller_emulation', 'true');
		if (setting('controls', 'pc') !== 'pc') return;
		for (const [action, [button, key]] of Object.entries(LAYOUT)) {
			const value = setting('key_' + action, key).trim();
			if (/^[A-Za-z0-9_]+$/.test(value)) add('keybind_' + button, value);
			else console.warn('Ignoring key_' + action + '=' + value + '; use a key name such as Q or Mouse4');
		}
	});
})();

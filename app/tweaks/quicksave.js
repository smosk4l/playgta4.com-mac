// Quicksave entry in the in-game phone (native option gta4_quicksave, a bool: "Add Quicksave to
// the single-player phone in GTA IV and both episodes"). Choosing it opens the stock save screen,
// so the save lands in saved_game_root like any other save and saves.js persists it.
// Off by default: the option patches the phone script, and with it enabled the phone screen
// rendered black. Setting: ?quicksave=on|off (remembered; ?quicksave=default forgets). An explicit
// ?gta4_quicksave=... native arg still wins.
'use strict';

LibertyTweaks.configure(({ add, setting }) => {
	const value = String(setting('quicksave', 'off')).toLowerCase();
	const on = !['off', 'false', '0', 'no'].includes(value);
	add('gta4_quicksave', on ? 'true' : 'false');
});

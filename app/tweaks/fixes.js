// Workarounds for engine bugs seen in the browser build.
// - The engine's "Advanced Graphics" page in the pause menu's Display tab renders as rows of garbage
//   glyphs ("LR ADVANCED" after long runs of filler) and drops the menu to ~9 FPS, with both the
//   stock and a translated american.gxt. Turning it off restores the retail Display page; the same
//   settings are reachable through URL settings (see tweaks/performance.js). ?advmenu=off hides it.
//   It stays on by default while a washed-out outdoor image seen with the tweaks is being isolated.
'use strict';

LibertyTweaks.configure(({ add, setting }) => {
	add('gta4_frontend_advanced_graphics_menu', setting('advmenu', 'on') === 'off' ? 'false' : 'true');
});

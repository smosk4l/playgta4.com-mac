// Workarounds for engine bugs seen in the browser build.
// - The engine's "Advanced Graphics" page in the pause menu's Display tab renders as rows of garbage
//   glyphs ("LR ADVANCED" after long runs of filler) and drops the menu to ~9 FPS, with both the
//   stock and a translated american.gxt. It also replaces the retail Display page, so brightness,
//   subtitles, radar, HUD and language could not be changed. Off by default, which restores the
//   retail page; the same graphics settings are reachable through URL settings (see
//   tweaks/performance.js). ?advmenu=on brings the engine's page back (remembered; ?advmenu=default forgets).
// - The pause menu's Map tab showed the live scene, with the map visible only where the sky is: the
//   frontend depth-tests against the scene depth. liberty.js (libertyInstallFrontendFixes) draws a black,
//   depth-clearing quad before it on the render thread. ?mapfix=off disables it.
// - The in-game phone screen was a black rectangle: the screen quad lost the depth test against the
//   phone body drawn just before it. liberty.js draws it with a depth bias. ?phonefix=off disables it.
// - Water was black/navy (and things under it showed as a white negative): the water shader exports alpha > 1
//   into the float HDR target, which the console clamps; liberty.js (libertyInstallAlphaClamp) saturates the alpha
//   of float-target src-alpha blends. ?waterfix=off disables it.
'use strict';

LibertyTweaks.configure(({ add, setting }) => {
	add('gta4_frontend_advanced_graphics_menu', setting('advmenu', 'off') === 'on' ? 'true' : 'false');
	globalThis.libertyMapFix = setting('mapfix', 'on') !== 'off';
	globalThis.libertyPhoneFix = setting('phonefix', 'on') !== 'off';
	globalThis.libertyWaterFix = setting('waterfix', 'on') !== 'off';
});

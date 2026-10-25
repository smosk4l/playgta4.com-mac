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
// - Over-exposed picture (floors, sand, sky and streets blown out to white, worse when looking at bright
//   areas): the renderer feeds auto-exposure and bloom through exact 2x downsample resolves (scene -> 1/2,
//   1/4 -> 1/8), and when the render size does not halve evenly (e.g. 2000x1125, 1600x900, 1285x723) those
//   passes read textures that are never written. The measured scene luminance is then 0, so exposure sits at
//   its maximum and bloom is lost. The automatic render size (boot.js, ?rescap=, ?upscale=) is therefore
//   snapped down to 16:9 multiples of 128x72 (1280x720, 1408x792 ... 1920x1080 ... 2560x1440), which halve
//   evenly through the chain (1280x720 goes in as --resolution=720p: the engine treats video_mode 1280x720 as
//   unset and renders at the canvas size). An explicit ?res= or ?arg=--video_mode_* is used as given.
//   ?exposurefix=off keeps the exact window-derived size.
'use strict';

// Adds the render-size args for a 16:9 size of `scale` units of 16x9 pixels (boot.js, resolution.js, upscaler.js).
globalThis.libertyAddVideoMode = (add, scale) => {
	if (new URLSearchParams(location.search).get('tweaks') === 'off' || LibertyTweaks.setting('exposurefix', 'on') === 'off') {
		add('video_mode_width', 2 * Math.round(scale * 8));
		add('video_mode_height', 2 * Math.round(scale * 4.5));
		return;
	}
	const m = Math.max(1, Math.floor(scale / 8 + 1e-9));
	if (m === 10) return add('resolution', '720p');
	add('video_mode_width', 128 * m);
	add('video_mode_height', 72 * m);
};

LibertyTweaks.configure(({ add, setting }) => {
	add('gta4_frontend_advanced_graphics_menu', setting('advmenu', 'off') === 'on' ? 'true' : 'false');
	globalThis.libertyMapFix = setting('mapfix', 'on') !== 'off';
	globalThis.libertyPhoneFix = setting('phonefix', 'on') !== 'off';
	globalThis.libertyWaterFix = setting('waterfix', 'on') !== 'off';
});

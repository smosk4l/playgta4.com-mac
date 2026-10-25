// Lower default render size for high-DPI screens. boot.js sizes the guest video mode to the
// screen's physical pixels (16:9, capped at 1440p), so a Retina MacBook always lands on
// 2560x1440 - too heavy for an M1 GPU through the WebGPU port of the Xbox 360 renderer.
// This picks the same viewport-derived 16:9 size but caps its height at ?rescap= (default 1080;
// e.g. 720, 900, 1080, 1440; remembered, ?rescap=default forgets). Any explicit size wins:
// ?res= (a --resolution preset such as 720p, 1080p, 1440p, 4k or 1280x720), ?arg=--resolution=,
// ?arg=--video_mode_width/height=, or a tweak loaded earlier (the upscaler) that set the size.
'use strict';

(function () {
	// Default height cap, and the smallest size allowed (the native upscaler's validated floor is 640x360).
	const DEFAULT_CAP = 1080;
	const MIN_HEIGHT = 360;

	LibertyTweaks.configure(({ params, add, has, setting }) => {
		if (params.get('res')) return;
		if (has('resolution') || has('video_mode_width') || has('video_mode_height')) return;

		// Opt-in for now: with the lower default the outdoor image came out washed-out on M1, so
		// without ?rescap= boot.js keeps its own size (screen pixels, capped at 1440p).
		const chosen = setting('rescap', null);
		if (chosen === null) return;
		let cap = parseInt(chosen, 10);
		if (!Number.isFinite(cap) || cap <= 0) cap = DEFAULT_CAP;
		cap = Math.max(cap, MIN_HEIGHT);

		// Same scale unit as boot.js (one unit = 16x9 pixels), with the cap expressed in units;
		// width/height stay even through the same 2 * round(x / 2) rounding.
		const dpr = globalThis.devicePixelRatio || 1;
		const scale = Math.max(Math.min(innerWidth * dpr / 16, innerHeight * dpr / 9, cap / 9), MIN_HEIGHT / 9);
		// tweaks/fixes.js snaps the size to one the renderer's exposure chain handles (?exposurefix=off).
		if (globalThis.libertyAddVideoMode) globalThis.libertyAddVideoMode(add, scale);
		else {
			add('video_mode_width', 2 * Math.round(scale * 8));
			add('video_mode_height', 2 * Math.round(scale * 4.5));
		}
	});
})();

// Opt-in FSR 1 spatial upscaling (render the scene below the output size, upscale with EASU + RCAS).
//
//   ?upscale=fsr1               enable (remembered; ?upscale=default or ?upscale=off to go back)
//   ?upscalequality=quality     ultra_quality (1.3x) | quality (1.5x, default) | balanced (1.7x) | performance (2x)
//   ?upscalesharpness=0.25      RCAS sharpness reduction in stops (0 = sharpest; engine default if unset)
//
// Off by default: the engine's FSR 1 pass belongs to its native (Vulkan/Metal) renderers. The browser
// build's WebGPU title-command renderer ships no EASU/RCAS shaders (only clear/convert/depth helpers and
// a bilinear present), so the engine is expected to log "<fsr1> is unavailable for this scene/backend;
// rendering at native resolution" and keep rendering at full size. Check the console for the
// "gta4-native-upscaler: ... render=WxH display=WxH" line to see what was actually selected.
// The engine also refuses FSR 1 under SSAA anti-aliasing, when the scene input would fall below
// 640x360, or when the backend converts to HDR before upscaling.
'use strict';

(function () {
	const tweaks = globalThis.LibertyTweaks;
	if (!tweaks) return;

	// Native spellings from the engine ("FSR 1 preset: ultra_quality, quality, balanced, or performance").
	const QUALITY = {
		ultra_quality: 'ultra_quality', ultra: 'ultra_quality', uq: 'ultra_quality',
		quality: 'quality', q: 'quality',
		balanced: 'balanced', b: 'balanced',
		performance: 'performance', perf: 'performance', p: 'performance',
	};

	tweaks.configure(({ params, add, has, setting }) => {
		const mode = String(setting('upscale', 'off')).toLowerCase();
		if (mode !== 'fsr1' && mode !== 'fsr' && mode !== 'on' && mode !== '1') return;
		// An explicit native --gta4_native_upscaler= wins over this tweak.
		if (has('gta4_native_upscaler')) return;

		add('gta4_native_upscaler', 'fsr1');
		const quality = QUALITY[String(setting('upscalequality', 'quality')).toLowerCase()] || 'quality';
		add('gta4_fsr1_quality', quality);
		const sharpness = parseFloat(setting('upscalesharpness', ''));
		if (Number.isFinite(sharpness) && sharpness >= 0) add('gta4_fsr1_sharpness_reduction', sharpness);

		// video_mode_width/height is the output (display) size; FSR 1 renders below it by the preset's
		// ratio. Give it the screen's pixel size (16:9, capped at 1440p, same formula as boot.js) unless
		// the user picked a resolution. Adding it here makes later resolution tweaks back off via has().
		if (!has('video_mode_width') && !has('video_mode_height') && !has('resolution') && !params.get('res')) {
			const scale = Math.min(innerWidth * devicePixelRatio / 16, innerHeight * devicePixelRatio / 9, 160);
			// tweaks/fixes.js snaps the size to one the renderer's exposure chain handles (?exposurefix=off).
			if (globalThis.libertyAddVideoMode) globalThis.libertyAddVideoMode(add, scale);
			else {
				add('video_mode_width', 2 * Math.round(scale * 8));
				add('video_mode_height', 2 * Math.round(scale * 4.5));
			}
		}
		console.info('[tweaks] upscaler: fsr1 quality=' + quality +
			' (experimental on WebGPU; look for the gta4-native-upscaler log line)');
	});
})();

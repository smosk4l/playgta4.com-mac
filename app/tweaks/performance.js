// CPU-saving world settings. The title is CPU-bound in the browser, and much of the per-frame
// simulation cost scales with how many peds and vehicles the population code keeps alive.
// ?density= is one multiplier for the four native population scales (ambient traffic, ambient
// peds, parked cars, scenario peds); 1 is the original game, default 0.75, accepted 0..1.
// ?preset=low|medium|high picks a bundle: low also shortens draw distance (0.75) and shadow
// distance (0.5); medium (the default) only thins the population; high is the original game.
// Every preset but high also turns motion blur off and uses cheaper anti-aliasing (engine defaults:
// motion blur on, SMAA high); low switches to FXAA, which is slightly softer. medium and high also
// stream the world from further ahead (see below); low keeps the engine's streaming margins.
// An explicit ?density= wins over the preset's density. Both are remembered; ?density=default
// or ?preset=default forgets. Any explicit ?arg=--gta4_*_scale= wins over everything here.
'use strict';

(function () {
	const PRESETS = {
		low: { density: 0.5, draw: 0.75, shadow: 0.5, blur: false, aa: 'fxaa' },
		medium: { density: 0.75, draw: 1, shadow: 1, blur: false, aa: 'smaa', smaa: 'low', stream: true },
		high: { density: 1, draw: 1, shadow: 1, blur: true, aa: 'smaa', stream: true },
	};
	// 'original' leaves the engine's graphics alone. medium/low changed the outdoor image (washed-out,
	// overexposed daylight) on M1, so they are opt-in until the culprit is isolated.
	const DEFAULT_PRESET = 'original';
	// Above 1 adds simulation work (the opposite of this tweak) and is untested against the pools.
	const MIN_DENSITY = 0;
	const MAX_DENSITY = 1;
	const POPULATION = [
		'gta4_traffic_density_scale',
		'gta4_ped_density_scale',
		'gta4_parked_car_density_scale',
		'gta4_scenario_ped_density_scale',
	];

	LibertyTweaks.configure(({ add, setting }) => {
		let name = String(setting('preset', DEFAULT_PRESET)).toLowerCase();
		if (name === 'original' && setting('density', null) === null) return;
		if (!Object.hasOwn(PRESETS, name)) name = 'high';
		const preset = PRESETS[name];

		let density = parseFloat(setting('density', String(preset.density)));
		if (!Number.isFinite(density)) density = preset.density;
		density = Math.min(Math.max(density, MIN_DENSITY), MAX_DENSITY);

		for (const arg of POPULATION) add(arg, String(density));
		// boot.js adds 1 for both afterwards; add() keeps whichever value comes first.
		add('gta4_draw_distance_scale', String(preset.draw));
		add('gta4_shadow_distance_scale', String(preset.shadow));
		add('gta4_motion_blur', String(preset.blur));
		add('gta4_native_anti_aliasing', preset.aa);
		if (preset.smaa) add('gta4_native_smaa_quality', preset.smaa);
		// Start streaming the world earlier (engine defaults: preload margin 100..250 world units,
		// budget scale 1.5) so textures arrive before the player does. ?stream=off keeps the defaults.
		if (preset.stream && setting('stream', 'on') !== 'off') {
			add('gta4_streaming_preload_min', '175');
			add('gta4_streaming_preload_max', '450');
			add('gta4_streaming_budget_scale', '2');
		}
	});
})();

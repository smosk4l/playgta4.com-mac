// Registry for optional playability tweaks (app/tweaks/*.js). Loaded before boot.js.
// Each tweak may register a configure hook that adds native engine args; hooks run in
// registration order before boot.js applies its defaults, and an explicit ?arg= always wins.
'use strict';

(function () {
	const params = new URLSearchParams(location.search);
	const hooks = [];

	// URL param > localStorage > fallback. A URL value is remembered for the next launch;
	// ?name=default forgets it. Storage can be unavailable (private windows), so every
	// access is guarded and the fallback is used instead.
	function setting(name, fallback) {
		const key = 'liberty.' + name;
		const fromUrl = params.get(name);
		try {
			if (fromUrl === 'default') {
				localStorage.removeItem(key);
				return fallback;
			}
			if (fromUrl !== null) {
				localStorage.setItem(key, fromUrl);
				return fromUrl;
			}
			const stored = localStorage.getItem(key);
			if (stored !== null) return stored;
		} catch (e) {
			if (fromUrl !== null && fromUrl !== 'default') return fromUrl;
		}
		return fallback;
	}

	// hook({ params, add, has, setting }) is called once while the engine args are built.
	function configure(hook) {
		hooks.push(hook);
	}

	function apply(context) {
		// ?tweaks=off runs the engine with boot.js defaults only (not remembered), to bisect issues.
		if (params.get('tweaks') === 'off') return;
		for (const hook of hooks) {
			try {
				hook({ ...context, setting });
			} catch (e) {
				console.warn('Tweak configure hook failed:', e);
			}
		}
	}

	globalThis.LibertyTweaks = { setting, configure, apply };
})();

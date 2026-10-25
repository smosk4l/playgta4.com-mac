// Cheat menu: GTA IV cheats are phone numbers, so each button dials one on the in-game phone by
// injecting keys into the engine (the engine has no cheat entry point reachable from JS).
// The 16 numbers checked by spcellphonecalling.sco (a switch over the joaat hash of the dialed
// string) plus the song-info number compared as text in spcellphone.sco form the complete list for
// this build. Sequence (checked in game): Up (phone out), Up (dial pad), Up×3 Left×2 to park the
// cursor on 1 (the grid clamps at its edges), arrows + Return per digit, Return once more to call
// (a full 10-digit number moves the cursor to the call key). A valid cheat hangs up and puts the
// phone away by itself.
// Panel: F8 or Option/Alt+C; arrows move, Return picks, Esc closes. Hotkeys: Alt+1 health/armor/ammo,
// Alt+2 weapons, Alt+3 wanted level off. DualSense (Gamepad API standard mapping): touchpad click
// (button 17) toggles, D-pad moves, Cross picks, Circle closes. While the panel is open or a number
// is being dialed, the engine reads a neutral pad from navigator.getGamepads (so stick drift or the
// closing Circle press cannot reach the game or move the phone cursor).
// ?cheats=off disables it (remembered; ?cheats=default forgets). Cheats block some achievements.
'use strict';

(function () {
	const mode = globalThis.LibertyTweaks ? LibertyTweaks.setting('cheats', 'on') : 'on';
	if (mode === 'off' || typeof document === 'undefined') return;

	const CHEATS = [
		{ group: 'Gracz', id: 'health', number: '4825550100', label: 'Życie, pancerz i amunicja', hotkey: 'Digit1' },
		{ group: 'Gracz', id: 'armor', number: '3625550100', label: 'Pancerz' },
		{ group: 'Gracz', id: 'wanted-off', number: '2675550100', label: 'Usuń list gończy', hotkey: 'Digit3' },
		{ group: 'Gracz', id: 'wanted-up', number: '2675550150', label: 'Podnieś list gończy' },
		{ group: 'Broń', id: 'weapons1', number: '4865550100', label: 'Zestaw broni 1', hotkey: 'Digit2' },
		{ group: 'Broń', id: 'weapons2', number: '4865550150', label: 'Zestaw broni 2' },
		{ group: 'Pojazdy', id: 'fib', number: '2275550100', label: 'FIB Buffalo' },
		{ group: 'Pojazdy', id: 'cognoscenti', number: '2275550142', label: 'Cognoscenti' },
		{ group: 'Pojazdy', id: 'turismo', number: '2275550147', label: 'Turismo' },
		{ group: 'Pojazdy', id: 'supergt', number: '2275550168', label: 'Super GT' },
		{ group: 'Pojazdy', id: 'comet', number: '2275550175', label: 'Comet' },
		{ group: 'Pojazdy', id: 'nrg', number: '6255550100', label: 'Motocykl NRG-900' },
		{ group: 'Pojazdy', id: 'sanchez', number: '6255550150', label: 'Motocykl Sanchez' },
		{ group: 'Pojazdy', id: 'annihilator', number: '3595550100', label: 'Helikopter Annihilator' },
		{ group: 'Pojazdy', id: 'jetmax', number: '9385550100', label: 'Łódź Jetmax' },
		{ group: 'Świat', id: 'weather', number: '4685550100', label: 'Zmień pogodę' },
		{ group: 'Świat', id: 'song', number: '9485550100', label: 'Info o utworze w radiu' },
	];

	// Dial pad cells as the arrows move between them; edges clamp (Left on 1 stays on 1).
	const PAD = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [1, 0], 5: [1, 1], 6: [1, 2], 7: [2, 0], 8: [2, 1], 9: [2, 2], 0: [3, 1] };
	const KEYS = {
		up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37],
		right: ['ArrowRight', 'ArrowRight', 39], accept: ['Enter', 'Enter', 13],
	};
	// Milliseconds at 30 FPS or better. The engine samples input once per frame, so a press shorter
	// than a frame can be missed: holds and gaps stretch to a few frames at the current frame rate
	// (boot.js publishes it as gpuStats.fps), and the phone animations are timed in frames too.
	const TIMING = { hold: 90, gap: 160, phone: 1800, pad: 1200, call: 6500 };
	const frameMs = () => 1000 / Math.min(60, Math.max(5, globalThis.gpuStats?.fps || 30));
	const atLeastFrames = (ms, frames) => Math.max(ms, frames * frameMs());
	const scaled = (ms) => ms * Math.max(1, frameMs() / (1000 / 30));

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const canvas = () => document.getElementById('canvas');
	let running = false;

	function send(type, [code, key, keyCode]) {
		const event = new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true });
		// keyCode/which are not part of KeyboardEventInit; SDL may still read them.
		Object.defineProperty(event, 'keyCode', { get: () => keyCode });
		Object.defineProperty(event, 'which', { get: () => keyCode });
		// Dispatched on the canvas so it bubbles through document to window, wherever SDL listens.
		(canvas() || window).dispatchEvent(event);
	}

	async function press(name, gap = TIMING.gap) {
		send('keydown', KEYS[name]);
		await sleep(atLeastFrames(TIMING.hold, 3));
		send('keyup', KEYS[name]);
		await sleep(atLeastFrames(gap, 3));
	}

	// Arrow presses from one pad cell to another (rows first; every cell of rows 0-2 exists).
	function route([r, c], [tr, tc]) {
		const moves = [];
		if (tr === 3 && c !== 1) { for (; c < 1; c++) moves.push('right'); for (; c > 1; c--) moves.push('left'); }
		for (; r < tr; r++) moves.push('down');
		for (; r > tr; r--) moves.push('up');
		for (; c < tc; c++) moves.push('right');
		for (; c > tc; c--) moves.push('left');
		return moves;
	}

	async function dial(cheat) {
		if (running) return;
		running = true;
		toast('Wybieram ' + format(cheat.number) + ' – ' + cheat.label + '…');
		try {
			canvas()?.focus();
			await sleep(250);
			await press('up');
			await sleep(scaled(TIMING.phone));
			await press('up');
			await sleep(scaled(TIMING.pad));
			// The cursor usually starts on 5, but park it on 1 so a missed or doubled press above
			// cannot shift every digit.
			for (const move of ['up', 'up', 'up', 'left', 'left']) await press(move);
			let at = PAD[1];
			for (const digit of cheat.number) {
				for (const move of route(at, PAD[digit])) await press(move);
				await press('accept');
				at = PAD[digit];
			}
			await press('accept');
			await sleep(scaled(TIMING.call));
			toast(cheat.label + ': numer wybrany', 'ok');
		} finally {
			running = false;
		}
	}

	function format(number) {
		return number.slice(0, 3) + '-' + number.slice(3, 6) + '-' + number.slice(6);
	}

	// ── Gamepad ──────────────────────────────────────────────────────────────────────────
	// The engine (SDL via emscripten_sample_gamepad_data) polls navigator.getGamepads. While the
	// panel is open, a number is being dialed, or a button pressed during either is still held, it
	// gets a released copy of each pad instead; the panel always reads the real state.
	const BTN = { cross: 0, circle: 1, up: 12, down: 13, left: 14, right: 15, touchpad: 17 };
	const realGetGamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;
	let holdBlock = false; // keep the pad neutral until every button is released
	const pressed = (pad, i) => !!pad?.buttons[i]?.pressed;
	const anyPressed = (pads) => pads.some((pad) => pad && pad.buttons.some((b) => b.pressed));
	const RELEASED = Object.freeze({ pressed: false, touched: false, value: 0 });
	function neutral(pad) {
		if (!pad) return pad;
		return {
			id: pad.id, index: pad.index, connected: pad.connected, mapping: pad.mapping,
			// One new timestamp per block: SDL skips states whose timestamp it has seen, so it applies
			// the released state once and then sees an idle pad, like a real pad at rest.
			timestamp: maskStamp,
			axes: pad.axes.map(() => 0), buttons: pad.buttons.map(() => RELEASED),
			vibrationActuator: pad.vibrationActuator, hapticActuators: pad.hapticActuators,
		};
	}
	let maskStamp = 0, masked = false;
	function padsBlocked(pads) {
		let block = !panel.hidden || running;
		if (!block && holdBlock) block = holdBlock = anyPressed(pads);
		if (block && !masked) maskStamp = performance.now();
		masked = block;
		return block;
	}
	if (realGetGamepads) {
		try {
			Object.defineProperty(navigator, 'getGamepads', {
				configurable: true, writable: true,
				value: function getGamepads() {
					const pads = realGetGamepads();
					try {
						return padsBlocked([...pads]) ? [...pads].map(neutral) : pads;
					} catch (e) {
						return pads;
					}
				},
			});
		} catch (e) {
			console.warn('[cheats] cannot wrap navigator.getGamepads:', e);
		}
	}

	// Styles live here so the tweak stays one file; they follow the F9 save panel (shell.css).
	const style = document.createElement('style');
	style.textContent = `
#cheats-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 41;
	width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 14px 16px;
	border: 1px solid var(--line); border-radius: 8px; background: rgba(11, 13, 16, 0.94); font-size: 12px; }
#cheats-panel[hidden] { display: none; }
#cheats-panel h2 { margin: 0 0 4px; font-size: 15px; color: var(--accent); }
#cheats-panel h3 { flex-basis: 100%; margin: 10px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dim); }
#cheats-panel section { display: flex; flex-wrap: wrap; gap: 6px; }
.cheats-note { margin: 0 0 4px; color: var(--dim); line-height: 1.4; }
#cheats-panel button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid #ffffff40;
	border-radius: 6px; background: #ffffff12; color: var(--fg); font: inherit; cursor: pointer; }
#cheats-panel button:hover, #cheats-panel button:focus-visible, #cheats-panel button.cheats-focus { border-color: var(--accent); }
#cheats-panel button.cheats-focus { background: #ffffff26; outline: none; }
#cheats-panel kbd { font: 10px ui-monospace, monospace; color: var(--dim); }
#cheats-panel .cheats-close { display: block; margin: 12px auto 0; }
#cheats-toast { position: fixed; left: 50%; top: 48px; transform: translate(-50%, -8px); z-index: 41; max-width: calc(100vw - 32px);
	padding: 6px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 13px; opacity: 0;
	pointer-events: none; transition: opacity 200ms ease, transform 200ms ease; }
#cheats-toast.show { opacity: 1; transform: translate(-50%, 0); }
#cheats-toast.ok { color: #7bd88f; }
#cheats-toast.err { color: #ff7b7b; }
`;
	document.head.append(style);

	// ── UI ───────────────────────────────────────────────────────────────────────────────
	const toastEl = document.createElement('div');
	toastEl.id = 'cheats-toast';
	toastEl.setAttribute('role', 'status');
	toastEl.setAttribute('aria-live', 'polite');
	let toastTimer = null;
	function toast(text, kind) {
		toastEl.textContent = text;
		toastEl.className = 'show ' + (kind || 'info');
		clearTimeout(toastTimer);
		if (kind) toastTimer = setTimeout(() => { toastEl.className = kind; }, 2500);
	}

	const panel = document.createElement('div');
	panel.id = 'cheats-panel';
	panel.hidden = true;
	const groups = new Map();
	for (const cheat of CHEATS) {
		if (!groups.has(cheat.group)) {
			const section = document.createElement('section');
			const title = document.createElement('h3');
			title.textContent = cheat.group;
			section.append(title);
			groups.set(cheat.group, section);
		}
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.cheat = cheat.id;
		button.title = format(cheat.number);
		button.textContent = cheat.label;
		if (cheat.hotkey) {
			const hint = document.createElement('kbd');
			hint.textContent = '⌥' + cheat.hotkey.slice(-1);
			button.append(hint);
		}
		groups.get(cheat.group).append(button);
	}
	const heading = document.createElement('h2');
	heading.textContent = 'Kody';
	const note = document.createElement('p');
	note.className = 'cheats-note';
	note.textContent = 'Kod wybiera numer w telefonie w grze: przez kilkanaście sekund nie ruszaj klawiatury ani pada. ' +
		'Działa tylko w trakcie zwykłej gry (nie w menu, przerywnikach ani w trakcie rozmowy). ' +
		'Jeśli numer się nie wpisze, schowaj telefon (Backspace) i spróbuj ponownie. Uwaga: kody mogą zablokować osiągnięcia.';
	const padNote = document.createElement('p');
	padNote.className = 'cheats-note';
	padNote.textContent = 'Klawiatura: strzałki, Enter wybierz, Esc zamknij. Pad: Touchpad: otwórz/zamknij, ✕ wybierz, ○ zamknij';
	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'cheats-close';
	close.dataset.action = 'close';
	close.textContent = 'Zamknij (F8 / ⌥C)';
	panel.append(heading, note, padNote, ...groups.values(), close);
	document.body.append(panel, toastEl);
	const buttons = () => [...panel.querySelectorAll('button')];

	let focused = null;
	function focusButton(button) {
		focused?.classList.remove('cheats-focus');
		focused = button || null;
		if (!focused) return;
		focused.classList.add('cheats-focus');
		focused.focus({ preventScroll: true });
		focused.scrollIntoView({ block: 'nearest' });
	}

	// Moves focus in a direction: Left/Right within the row, Up/Down to the nearest row above or
	// below and the button there closest horizontally (the buttons wrap in rows).
	function navigate(dir) {
		const list = buttons();
		if (!focused || !list.includes(focused)) return focusButton(list[0]);
		const center = (b) => { const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
		const [fx, fy] = center(focused);
		const vertical = dir === 'up' || dir === 'down';
		const sign = dir === 'up' || dir === 'left' ? -1 : 1;
		const candidates = list.filter((b) => b !== focused).map((b) => {
			const [x, y] = center(b);
			return { b, along: sign * (vertical ? y - fy : x - fx), across: Math.abs(vertical ? x - fx : y - fy) };
		}).filter((c) => c.along > 8 && (vertical || c.across < 8));
		if (!candidates.length) return;
		const row = Math.min(...candidates.map((c) => c.along));
		const pick = vertical
			? candidates.filter((c) => c.along < row + 8).sort((a, b) => a.across - b.across)[0]
			: candidates.sort((a, b) => a.along - b.along)[0];
		focusButton(pick.b);
	}

	function toggle(show) {
		panel.hidden = show === undefined ? !panel.hidden : !show;
		if (!panel.hidden) {
			if (document.pointerLockElement) document.exitPointerLock();
			focusButton(buttons()[0]);
		} else {
			focusButton(null);
			holdBlock = true; // a button that closed the panel is still down
			canvas()?.focus();
		}
	}

	function run(id) {
		const cheat = CHEATS.find((c) => c.id === id);
		if (!cheat) return Promise.reject(new Error('unknown cheat ' + id));
		if (running) { toast('Poczekaj, poprzedni kod jest jeszcze wybierany', 'err'); return Promise.resolve(); }
		toggle(false);
		return dial(cheat).catch((e) => toast('Kod nie zadziałał: ' + (e.message || e), 'err'));
	}

	function activate(button) {
		if (!button) return;
		button.blur();
		if (button.dataset.action === 'close') toggle(false);
		else if (button.dataset.cheat) run(button.dataset.cheat);
	}

	for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'wheel']) {
		panel.addEventListener(type, (event) => event.stopPropagation());
	}
	panel.addEventListener('click', (event) => activate(event.target.closest('button')));

	// F8, or Option/Alt+C (C is crouch, so its keyup is swallowed too); Option/Alt+1..3 run the
	// favourites. event.code is used because Option changes event.key on macOS. While the panel is
	// open the game gets no key presses (key releases still pass so nothing stays held).
	const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
	const plainAlt = (event) => event.altKey && !event.ctrlKey && !event.metaKey;
	const swallowedUps = new Set();
	const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
	const DIAL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace']);
	window.addEventListener('keydown', (event) => {
		if (!event.isTrusted) return; // our own injected keys
		if (event.code === 'F8' || (event.code === 'KeyC' && plainAlt(event))) {
			swallow(event);
			swallowedUps.add(event.code);
			if (!event.repeat) toggle();
			return;
		}
		const favourite = plainAlt(event) && CHEATS.find((c) => c.hotkey === event.code);
		if (favourite) {
			swallow(event);
			swallowedUps.add(event.code);
			if (!event.repeat) run(favourite.id);
			return;
		}
		if (running && DIAL_KEYS.has(event.code)) {
			// A real phone key would move the cursor under the dialer.
			swallow(event);
			swallowedUps.add(event.code);
			return;
		}
		if (panel.hidden) return;
		swallow(event);
		swallowedUps.add(event.code);
		if (event.code === 'Escape') toggle(false);
		else if (DIRS[event.code]) navigate(DIRS[event.code]);
		else if ((event.code === 'Enter' || event.code === 'Space' || event.code === 'NumpadEnter') && !event.repeat) activate(focused);
		else if (event.code === 'Tab') navigate(event.shiftKey ? 'left' : 'right');
	}, true);
	window.addEventListener('keyup', (event) => {
		if (event.isTrusted && swallowedUps.delete(event.code)) swallow(event);
	}, true);
	window.addEventListener('blur', () => swallowedUps.clear());

	// Pad polling for the panel (real state). Edges only, with D-pad auto-repeat.
	const prev = new Map(); // pad index -> previous pressed[] of the buttons we use
	const repeatAt = new Map();
	function pollPads(now) {
		requestAnimationFrame(pollPads);
		if (!realGetGamepads) return;
		let pads;
		try { pads = realGetGamepads(); } catch (e) { return; }
		for (const pad of pads) {
			if (!pad || !pad.connected) continue;
			const was = prev.get(pad.index) || {};
			const is = {};
			for (const [name, i] of Object.entries(BTN)) is[name] = pressed(pad, i);
			prev.set(pad.index, is);
			const edge = (name) => is[name] && !was[name];
			if (edge('touchpad') && !running) { toggle(); continue; }
			if (panel.hidden) continue;
			if (edge('circle')) { toggle(false); continue; }
			if (edge('cross')) { activate(focused); continue; }
			for (const dir of ['up', 'down', 'left', 'right']) {
				const key = pad.index + dir;
				if (edge(dir)) { navigate(dir); repeatAt.set(key, now + 400); }
				else if (is[dir] && now >= (repeatAt.get(key) ?? Infinity)) { navigate(dir); repeatAt.set(key, now + 140); }
				else if (!is[dir]) repeatAt.delete(key);
			}
		}
	}
	if (realGetGamepads) requestAnimationFrame(pollPads);

	globalThis.LibertyCheats = { list: CHEATS, run, toggle, timing: TIMING, get busy() { return running; }, _route: route, _navigate: navigate };
})();

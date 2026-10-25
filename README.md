![playgta4.com](https://i.pinimg.com/736x/c3/27/8c/c3278c78ca8ddff27cfca9aeb5a93855.jpg)

# playgta4.com

GTA IV in the browser, built on Liberty Recompiled with WebAssembly and WebGPU. Still a work in progress.

## Run

Requires Node.js 18+, Git LFS, and a browser with WebGPU and WebAssembly memory64 support.

```sh
git lfs install
git clone https://github.com/luvettee/playgta4.com.git
cd playgta4.com
git lfs pull
node runtime/launch.js
```

Open http://localhost:3001 and click inside the game to enable audio and input. No build step or npm install needed. You can also launch with `./start.sh` on macOS and Linux. Press Ctrl+C to stop the server.

## Controls

WASD to move or drive, mouse to look, F to enter or leave a car, Alt+Enter for fullscreen, and F9 for the save backup panel.

## Saves

In-game saves are stored in two places:

- **Browser storage** (IndexedDB) for the address you opened, e.g. `http://localhost:3001`. Storage is per origin: `localhost:3001`, `127.0.0.1:3001` and any other port each have their own copy.
- **The `saves/` folder** in this repo (ignored by git), written by `node runtime/launch.js` whenever the game saves. Previous versions of overwritten or deleted files are kept in `saves/.previous/`.

On startup the newest copy of each file wins, so saves made under one address (or in another browser) are picked up from `saves/` under any other. A small message confirms each save; if storage fails, an error is shown instead.

Back up and restore: press **F9** in game for **Export saves** (downloads one `.json` file) and **Import saves** (loads such a file, then asks to reload). You can also copy the `saves/` folder itself. Clearing site data removes the browser copy, but `saves/` is not touched.

See [Liberty License.txt](Liberty%20License.txt) for the engine license.

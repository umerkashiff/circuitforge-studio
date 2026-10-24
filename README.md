# CircuitForge Studio v2

Breadboard circuit simulator by Umer. Plain HTML, CSS and ES modules — no build step, no server.

## Run locally
Serve this folder with any static server, e.g. `npx serve .` or `python3 -m http.server`, then open the printed URL.
(Opening `index.html` straight from disk won't work: browsers block ES modules on `file://`.)

## Deploy to Vercel
1. Push the repository to GitHub and import it in Vercel.
2. Leave **Root Directory** as the repository root. Framework preset: **Other**. No build command, no output directory.
3. Deploy. `vercel.json` here sets security headers and makes browsers revalidate scripts after each deploy.

## Layout
- `src/sim/` — circuit engine (nodal analysis), device models, wire router
- `src/parts/` — part library, 74xx/40xx chip models
- `src/mcu/` — Arduino-sketch transpiler, board runtime, board definitions
- `src/editor.js`, `src/ui.js`, `src/view/renderer.js` — interaction, panels, drawing
- `src/settings.js` — user preferences (stored in the browser)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const assetsDir = path.join(dist, 'assets');

console.log('🚀 Starting CircuitForge Studio production build & obfuscation...');

// 1. Clean dist directory
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(assetsDir, { recursive: true });

// 2. Anti-DevTools, Anti-Tamper & Protection code
const antiTamperCode = `
// Anti-tamper & DevTools blocking protections
(function() {
  'use strict';
  // Disable right-click context menu
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); return false; }, true);

  // Disable DevTools & source inspection shortcuts
  window.addEventListener('keydown', function(e) {
    if (
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) ||
      (e.metaKey && e.altKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) ||
      (e.ctrlKey && (e.key === 'U' || e.key === 'u' || e.key === 'S' || e.key === 's')) ||
      (e.metaKey && (e.key === 'U' || e.key === 'u' || e.key === 'S' || e.key === 's'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // Anti-debugging loop: hoist compiled Function once to avoid per-tick GC overhead
  try {
    var _0xdbgFn = Function('debugger');
    setInterval(_0xdbgFn, 1000);
  } catch (err) {}

  // Console poisoning: suppress sensitive debugging logs
  try {
    ['log', 'debug', 'info', 'warn', 'error', 'table', 'trace'].forEach(function(m) {
      console[m] = function() {};
    });
  } catch (err) {}
})();
`;

const obfuscatedAntiTamper = JavaScriptObfuscator.obfuscate(antiTamperCode, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  splitStrings: true,
  splitStringsChunkLength: 10,
  selfDefending: true,
}).getObfuscatedCode();

// Keep hot MNA math and Canvas2D frame loops at native minified esbuild speed;
// apply RC4 string encryption & hex obfuscation to the UI, app, parts, and MCU layers.
const HOT_NATIVE_PATHS = new Set([
  'src/sim/engine.js',
  'src/sim/devices.js',
  'src/view/renderer.js',
]);

const selectiveObfuscatePlugin = {
  name: 'selective-obfuscate',
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, (args) => {
      const rel = path.relative(root, args.path).replace(/\\/g, '/');
      if (!rel.startsWith('src/') || HOT_NATIVE_PATHS.has(rel)) return null;
      const src = fs.readFileSync(args.path, 'utf8');
      const obf = JavaScriptObfuscator.obfuscate(src, {
        compact: true,
        ignoreImports: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        numbersToExpressions: false,
        selfDefending: false,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        stringArray: true,
        stringArrayEncoding: ['rc4'],
        stringArrayThreshold: 0.75,
        splitStrings: true,
        splitStringsChunkLength: 10,
        disableConsoleOutput: false,
        simplify: true,
      }).getObfuscatedCode();
      return { contents: obf, loader: 'js' };
    });
  },
};

// 3. Bundle & selectively obfuscate JS using esbuild
console.log('📦 Bundling + selectively obfuscating modules into single native-fast stream...');
const bundleResult = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  plugins: [selectiveObfuscatePlugin],
  write: false,
});

const finalJs = obfuscatedAntiTamper + '\n' + bundleResult.outputFiles[0].text;
const jsHash = crypto.createHash('md5').update(finalJs).digest('hex').slice(0, 8);
const jsFileName = `app.${jsHash}.js`;
fs.writeFileSync(path.join(assetsDir, jsFileName), finalJs, 'utf8');
console.log(`✅ Built JS: assets/${jsFileName} (${(finalJs.length / 1024).toFixed(1)} KB)`);

// 5. Minify and bundle CSS
console.log('🎨 Minifying stylesheet...');
const cssResult = await esbuild.build({
  entryPoints: [path.join(root, 'css', 'app.css')],
  bundle: true,
  minify: true,
  sourcemap: false,
  write: false,
});
const finalCss = cssResult.outputFiles[0].text;
const cssHash = crypto.createHash('md5').update(finalCss).digest('hex').slice(0, 8);
const cssFileName = `app.${cssHash}.css`;
fs.writeFileSync(path.join(assetsDir, cssFileName), finalCss, 'utf8');
console.log(`✅ Minified CSS generated: assets/${cssFileName} (${(finalCss.length / 1024).toFixed(1)} KB)`);

// 6. Copy static assets (favicon, recorded demo GIFs, etc.)
if (fs.existsSync(path.join(root, 'favicon.svg'))) {
  fs.copyFileSync(path.join(root, 'favicon.svg'), path.join(dist, 'favicon.svg'));
}
const demosSrc = path.join(root, 'assets', 'demos');
if (fs.existsSync(demosSrc)) {
  const demosDest = path.join(assetsDir, 'demos');
  fs.mkdirSync(demosDest, { recursive: true });
  for (const f of fs.readdirSync(demosSrc)) {
    fs.copyFileSync(path.join(demosSrc, f), path.join(demosDest, f));
  }
  console.log(`✅ Copied ${fs.readdirSync(demosSrc).length} demo media files to dist/assets/demos/`);
}

// 7. Generate production studio.html (Simulator)
console.log('📄 Generating production studio.html (Simulator)...');
let studioHtml = fs.readFileSync(path.join(root, 'studio.html'), 'utf8');

// Replace CSS link and script module
studioHtml = studioHtml.replace(/<link\s+rel="stylesheet"\s+href="css\/app\.css">/i, `<link rel="stylesheet" href="assets/${cssFileName}">`);
studioHtml = studioHtml.replace(/<script\s+type="module"\s+src="src\/main\.js"><\/script>/i, `<script type="module" src="assets/${jsFileName}"></script>`);

// Add oncontextmenu="return false;" to body tag
studioHtml = studioHtml.replace(/<body([^>]*)>/i, '<body$1 oncontextmenu="return false;">');

// Strip HTML comments
studioHtml = studioHtml.replace(/<!--[\s\S]*?-->/g, '');

fs.writeFileSync(path.join(dist, 'studio.html'), studioHtml, 'utf8');
console.log('✅ Production studio.html created!');

// 8. Build lightweight, fast landing page (dist/index.html)
console.log('✨ Bundling & minifying landing page assets...');
const landingJsRes = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'landing.js')],
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  write: false,
});
const landingJs = landingJsRes.outputFiles[0].text;
const landingJsHash = crypto.createHash('md5').update(landingJs).digest('hex').slice(0, 8);
const landingJsName = `landing.${landingJsHash}.js`;
fs.writeFileSync(path.join(assetsDir, landingJsName), landingJs, 'utf8');
console.log(`✅ Built landing JS: assets/${landingJsName} (${(landingJs.length / 1024).toFixed(1)} KB)`);

const landingCssRes = await esbuild.build({
  entryPoints: [path.join(root, 'css', 'landing.css')],
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  write: false,
});
const landingCss = landingCssRes.outputFiles[0].text;
const landingCssHash = crypto.createHash('md5').update(landingCss).digest('hex').slice(0, 8);
const landingCssName = `landing.${landingCssHash}.css`;
fs.writeFileSync(path.join(assetsDir, landingCssName), landingCss, 'utf8');
console.log(`✅ Built landing CSS: assets/${landingCssName} (${(landingCss.length / 1024).toFixed(1)} KB)`);

let landingHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
landingHtml = landingHtml.replace(/<link\s+rel="stylesheet"\s+href="css\/landing\.css">/i, `<link rel="stylesheet" href="assets/${landingCssName}">`);
landingHtml = landingHtml.replace(/<script\s+defer\s+src="src\/landing\.js"><\/script>/i, `<script defer src="assets/${landingJsName}"></script>`);
landingHtml = landingHtml.replace(/<!--[\s\S]*?-->/g, '');
fs.writeFileSync(path.join(dist, 'index.html'), landingHtml, 'utf8');
console.log('✅ Production landing index.html created!');

console.log('🎉 Production build complete! Ready for Vercel deployment in dist/');

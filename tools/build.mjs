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

  // Anti-debugging loop: triggers if DevTools is opened
  function _0xdbg() {
    function _0xt() {
      (function() {}['constructor']('debugger')());
    }
    setInterval(_0xt, 100);
  }
  try { _0xdbg(); } catch (err) {}

  // Console poisoning: suppress sensitive debugging logs
  try {
    ['log', 'debug', 'info', 'warn', 'error', 'table', 'trace'].forEach(function(m) {
      console[m] = function() {};
    });
  } catch (err) {}
})();
`;

// 3. Bundle JS using esbuild
console.log('📦 Bundling JavaScript modules into a single stream...');
const bundleResult = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  write: false,
});

const bundledJs = antiTamperCode + '\n' + bundleResult.outputFiles[0].text;

// 4. Heavy Obfuscation using javascript-obfuscator
console.log('🔒 Applying advanced code obfuscation (string encryption, mangling, control flow)...');
const obfuscationResult = JavaScriptObfuscator.obfuscate(bundledJs, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.85,
  splitStrings: true,
  splitStringsChunkLength: 10,
  selfDefending: true,
  disableConsoleOutput: true,
  numbersToExpressions: true,
  simplify: true,
});

const finalJs = obfuscationResult.getObfuscatedCode();
const jsHash = crypto.createHash('md5').update(finalJs).digest('hex').slice(0, 8);
const jsFileName = `app.${jsHash}.js`;
fs.writeFileSync(path.join(assetsDir, jsFileName), finalJs, 'utf8');
console.log(`✅ Obfuscated JS generated: assets/${jsFileName} (${(finalJs.length / 1024).toFixed(1)} KB)`);

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

// 6. Copy static assets (favicon, etc.)
if (fs.existsSync(path.join(root, 'favicon.svg'))) {
  fs.copyFileSync(path.join(root, 'favicon.svg'), path.join(dist, 'favicon.svg'));
}

// 7. Generate production index.html
console.log('📄 Generating production index.html...');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Replace CSS link and script module
html = html.replace(/<link\s+rel="stylesheet"\s+href="css\/app\.css">/i, `<link rel="stylesheet" href="assets/${cssFileName}">`);
html = html.replace(/<script\s+type="module"\s+src="src\/main\.js"><\/script>/i, `<script type="module" src="assets/${jsFileName}"></script>`);

// Add oncontextmenu="return false;" to body tag
html = html.replace(/<body([^>]*)>/i, '<body$1 oncontextmenu="return false;">');

// Strip HTML comments
html = html.replace(/<!--[\s\S]*?-->/g, '');

fs.writeFileSync(path.join(dist, 'index.html'), html, 'utf8');
console.log('✅ Production index.html created!');

console.log('🎉 Production build complete! Ready for Vercel deployment in dist/');

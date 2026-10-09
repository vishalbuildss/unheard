'use strict';
// Copies the self-hosted fonts and bundles src/main.js (with three.js and socket.io) into public/app.js.
// Nothing is loaded from the internet at runtime.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const fontSrc = name => path.join(root, 'node_modules', '@fontsource', name, 'files');
const fonts = [
  ['big-shoulders-stencil-display', 'big-shoulders-stencil-display-latin-800-normal.woff2', 'stencil-800.woff2'],
  ['big-shoulders-stencil-display', 'big-shoulders-stencil-display-latin-600-normal.woff2', 'stencil-600.woff2'],
  ['barlow', 'barlow-latin-400-normal.woff2', 'barlow-400.woff2'],
  ['barlow', 'barlow-latin-600-normal.woff2', 'barlow-600.woff2'],
  ['barlow', 'barlow-latin-700-normal.woff2', 'barlow-700.woff2'],
  ['space-mono', 'space-mono-latin-400-normal.woff2', 'mono-400.woff2'],
  ['space-mono', 'space-mono-latin-700-normal.woff2', 'mono-700.woff2']
];
const outFonts = path.join(root, 'public', 'fonts');
fs.mkdirSync(outFonts, { recursive: true });
for (const [pkg, file, out] of fonts) fs.copyFileSync(path.join(fontSrc(pkg), file), path.join(outFonts, out));

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  minify: !watch,
  sourcemap: false,
  format: 'iife',
  target: ['es2020'],
  outfile: path.join(root, 'public', 'app.js'),
  legalComments: 'none',
  logLevel: 'info'
};
if (watch) esbuild.context(options).then(ctx => ctx.watch());
else esbuild.build(options).catch(() => process.exit(1));

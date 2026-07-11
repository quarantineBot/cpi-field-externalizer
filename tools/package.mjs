// Build the Chrome Web Store upload zip — only the shipped files (no tests/tools/docs).
// Reuses the vendored JSZip (loaded as CommonJS). Run: node tools/package.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rel = (p) => fileURLToPath(new URL(p, root));

// Load the vendored JSZip (UMD). The repo is "type":"module", so require() would treat it as
// ESM and miss module.exports — evaluate it against a sandbox global instead.
const sandbox = {};
new Function('window', 'self', 'module', 'exports', await readFile(rel('vendor/jszip.min.js'), 'utf8'))(sandbox, sandbox, undefined, undefined);
const JSZip = sandbox.JSZip;

const SHIPPED = [
  'manifest.json',
  'popup.html',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'vendor/jszip.min.js',
  'src/engine/engine.js',
  'src/engine/pvm.js',
  'src/plugin/field-externalizer.plugin.js',
];

const version = JSON.parse(await readFile(rel('manifest.json'), 'utf8')).version;
const zip = new JSZip();
for (const p of SHIPPED) zip.file(p, await readFile(rel(p)));

await mkdir(rel('dist'), { recursive: true });
const name = `iflow-field-externalizer-v${version}.zip`;
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(rel('dist/' + name), buf);
console.log(`Packaged ${SHIPPED.length} files → dist/${name} (${buf.length} bytes)`);

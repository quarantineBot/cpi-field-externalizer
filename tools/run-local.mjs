#!/usr/bin/env node
// Local test harness — run the externalizer engine against an UNZIPPED iFlow folder.
// No dependencies, no tenant access. This is the fastest way to validate detection and
// the parameters.prop / parameters.propdef output against a real exported iFlow.
//
// Usage:
//   1. In CPI, export your iFlow ("..." -> Export) and unzip it to a folder.
//   2. node tools/run-local.mjs <iflow-dir> [out-dir] [--dry] [--min=high|medium]
//
//   --dry            analyze and print only, write nothing
//   --min=high       only auto-select high-confidence candidates (default: medium)

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname, sep } from 'node:path';

// engine.js is environment-agnostic: importing it for its side effect populates the global.
await import('../src/engine/engine.js');
const { analyze, apply } = globalThis.__CpixEngine;

const [, , inDir, maybeOut, ...flags] = process.argv;
const rest = [maybeOut, ...flags].filter(Boolean);
const outDir = rest.find((a) => !a.startsWith('--'));
const dry = rest.includes('--dry');
const min = (rest.find((a) => a.startsWith('--min=')) || '--min=medium').split('=')[1];
const RANK = { high: 2, medium: 1, low: 0 };

if (!inDir) {
  console.error('Usage: node tools/run-local.mjs <iflow-dir> [out-dir] [--dry] [--min=high|medium]');
  process.exit(1);
}

async function walk(dir, base = dir, acc = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, acc);
    else acc[relative(base, p).split(sep).join('/')] = await readFile(p);
  }
  return acc;
}

const buffers = await walk(inDir);
const strings = Object.fromEntries(
  Object.entries(buffers).map(([k, v]) => [k, v.toString('utf8')]),
);

const { iflowPath, candidates, totalProperties } = analyze(strings);
console.log(`\niFlow model : ${iflowPath}`);
console.log(`Properties  : scanned ${totalProperties}, ${candidates.length} externalization candidate(s)\n`);

const chosen = candidates.filter((c) => RANK[c.confidence] >= (RANK[min] ?? 1));
for (const c of candidates) {
  const box = chosen.includes(c) ? '[x]' : '[ ]';
  console.log(`${box} ${c.suggestedName.padEnd(34)} ${c.confidence.padEnd(6)} ${c.reason}`);
  console.log(`    step="${c.stepName}"  key=${c.key}`);
  console.log(`    value=${JSON.stringify(c.value).slice(0, 120)}`);
}

if (dry) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}
if (!outDir) {
  console.error('\nProvide an <out-dir> to write results, or pass --dry to preview only.');
  process.exit(1);
}

const selections = chosen.map((c) => ({ id: c.id, paramName: c.suggestedName }));
const { files, applied } = apply(strings, selections);

for (const [path, buf] of Object.entries(buffers)) {
  const target = join(outDir, path);
  await mkdir(dirname(target), { recursive: true });
  // Re-serialize only files the engine changed; copy everything else byte-for-byte.
  if (files[path] !== undefined && files[path] !== strings[path]) {
    await writeFile(target, files[path], 'utf8');
  } else {
    await writeFile(target, buf);
  }
}
// Emit newly-created files (e.g. parameters.prop/.propdef that didn't exist before).
for (const [path, content] of Object.entries(files)) {
  if (buffers[path] === undefined) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

console.log(`\nExternalized ${applied.length} field(s):`);
for (const a of applied) console.log(`   {{${a.name}}} = ${a.value}`);
console.log(`\nWritten to: ${outDir}`);
console.log('Re-zip the folder contents and import back into CPI, or use it to review the diff.');

#!/usr/bin/env node
/**
 * Build the two packages this project ships, from one list of files.
 *
 *   node pack.mjs            # writes dist/agentbridge-<version>.zip and dist/agentbridge-<version>-bundle.zip
 *   node test/package.mjs    # unpacks them again and refuses a package Chrome would reject
 *
 * The 0.5.1 zip was zipped by hand and put the icons at the root while the
 * manifest asked for `icons/icon16.png`, so Chrome refused to load it. A package
 * built by hand is a package nobody checked. This script is the only way to make
 * one, and it verifies what it wrote before it says it is done.
 *
 * - `agentbridge-<version>.zip` — the extension, exactly what the Web Store takes.
 * - `agentbridge-<version>-bundle.zip` — the same extension plus the bridge server
 *   and a START-HERE file, for someone who wants the whole thing in one download.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(HERE, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const version = manifest.version;

// Everything the extension needs at runtime. Listed, not globbed: a glob picks up
// whatever someone left in the folder, and a package is not a folder listing.
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'README.md',
  'PRIVACY.md',
  'LICENSE',
];
const BUNDLE_EXTRA = ['bridge-server.mjs', 'START-HERE.md'];

/** Every path the manifest itself promises, so the package can be held to it. */
function manifestPaths(m) {
  const paths = new Set();
  for (const p of Object.values(m.icons || {})) paths.add(p);
  if (m.action?.default_popup) paths.add(m.action.default_popup);
  if (m.action?.default_icon) {
    for (const p of Object.values(m.action.default_icon)) paths.add(p);
  }
  if (m.background?.service_worker) paths.add(m.background.service_worker);
  for (const cs of m.content_scripts || []) for (const js of cs.js || []) paths.add(js);
  for (const w of m.web_accessible_resources || []) for (const r of w.resources || []) paths.add(r);
  return [...paths];
}

function listZip(file) {
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function build(name, files) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-pack-'));
  for (const rel of files) {
    const from = path.join(HERE, rel);
    if (!fs.existsSync(from)) throw new Error(`missing file for the package: ${rel}`);
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, name);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', out, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });

  // Hold the archive to the manifest, from inside the archive.
  const inside = new Set(listZip(out));
  for (const p of manifestPaths(manifest)) {
    if (!inside.has(p)) throw new Error(`${name} is missing ${p}, which manifest.json requires`);
  }
  for (const rel of files) {
    if (!inside.has(rel)) throw new Error(`${name} is missing ${rel}`);
  }
  const buf = fs.readFileSync(out);
  return {
    name,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    files: inside.size,
  };
}

const extension = build(`agentbridge-${version}.zip`, EXTENSION_FILES);
const bundle = build(`agentbridge-${version}-bundle.zip`, [...EXTENSION_FILES, ...BUNDLE_EXTRA]);

for (const p of [extension, bundle]) {
  console.log(`${p.name}  ${p.files} files  ${p.bytes} bytes`);
  console.log(`  sha256 ${p.sha256}`);
}
console.log(`\nBoth packages carry every path manifest.json names. Upload \`${extension.name}\` to the store.`);

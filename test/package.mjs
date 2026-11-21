#!/usr/bin/env node
/**
 * Open the packages and hold them to what Chrome will check.
 *
 *   node test/package.mjs
 *
 * Run it after `node pack.mjs`. It exists because the 0.5.1 zip declared
 * `icons/icon16.png` in the manifest and shipped `icon16.png` at the root: Chrome
 * refused to load it, and nobody found out until the package was handed over. A
 * check that reads the archive the way the browser does is the only thing that
 * makes "the package is ready" a fact.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const version = manifest.version;
const DIST = path.join(HERE, 'dist');

let failures = 0;
const ok = (m) => console.log(`ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`FAIL  ${m}`);
};

function entries(file) {
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function readMember(file, name) {
  return execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' });
}

const extensionZip = path.join(DIST, `agentbridge-${version}.zip`);
const bundleZip = path.join(DIST, `agentbridge-${version}-bundle.zip`);

if (!fs.existsSync(extensionZip)) {
  bad(`${extensionZip} does not exist — run \`node pack.mjs\` first`);
} else {
  const inside = entries(extensionZip);
  ok(`the store package exists (${fs.statSync(extensionZip).size} bytes, ${inside.length} entries)`);

  // What the browser reads, read from the archive.
  const packaged = JSON.parse(readMember(extensionZip, 'manifest.json'));
  if (packaged.version === version) ok(`the packaged manifest says ${version}`);
  else bad(`the packaged manifest says ${packaged.version}, the folder says ${version}`);

  const required = new Set([
    ...Object.values(packaged.icons || {}),
    packaged.action?.default_popup,
    packaged.background?.service_worker,
    ...(packaged.content_scripts || []).flatMap((cs) => cs.js || []),
  ].filter(Boolean));

  for (const p of required) {
    if (inside.includes(p)) ok(`the manifest's ${p} is in the archive`);
    else bad(`the manifest requires ${p}, and the archive does not contain it`);
  }

  // Things that must never be in a package.
  for (const forbidden of ['keys.json', 'node_modules/', 'bridge-server.mjs']) {
    if (inside.some((e) => e === forbidden || e.startsWith(forbidden))) {
      bad(`the store package contains ${forbidden}`);
    }
  }
  ok('no keys, no node_modules, and no server file in the store package');

  // The popup tells a stranger where to get the server; that URL has to exist for
  // this version, or the instructions are a dead end.
  const popup = readMember(extensionZip, 'popup.html');
  const url = popup.match(/raw\.githubusercontent\.com\/[^"<\s]+bridge-server\.mjs/);
  if (/id="status"[^>]*>Bridge: disconnected</.test(popup)) {
    bad('popup.html paints "disconnected" before it knows anything — a fresh popup lies for a second');
  } else if (!/id="status"[^>]*>Bridge: checking/.test(popup)) {
    bad('popup.html does not start in a "checking" state');
  } else {
    ok('the popup starts at "checking…", not at a guess');
  }

  if (!url) bad('popup.html has no download command for the bridge server');
  else if (url[0].includes(`/v${version}/`)) ok(`the popup points at v${version}: ${url[0]}`);
  else bad(`the popup points at an older tag than ${version}: ${url[0]}`);
}

if (!fs.existsSync(bundleZip)) {
  bad(`${bundleZip} does not exist — run \`node pack.mjs\` first`);
} else {
  const inside = entries(bundleZip);
  ok(`the bundle exists (${fs.statSync(bundleZip).size} bytes, ${inside.length} entries)`);
  for (const p of ['bridge-server.mjs', 'START-HERE.md', 'manifest.json', 'icons/icon16.png']) {
    if (inside.includes(p)) ok(`the bundle contains ${p}`);
    else bad(`the bundle is missing ${p}`);
  }
}

if (failures) {
  console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\nPASS — both packages are what their manifests promise.');

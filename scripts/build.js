#!/usr/bin/env node
// YTM Lyrics+ — cross-browser build & package script. Zero dependencies,
// Node built-ins only (fs / path / child_process).
//
//   node scripts/build.js            → dist/chrome + dist/firefox + both zips
//   node scripts/build.js chrome     → Chrome target only
//   node scripts/build.js firefox    → Firefox target only
//
// Output zips contain the extension contents at the archive ROOT —
// manifest.json sits at the top level, exactly what the stores expect.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Everything the packaged extension ships. Dev-only files (README, TODO,
// screenshots/, store/, scripts/, dist/, dotfiles) stay out of the package.
const SHIP = [
  'background.js',
  'content.js',
  'sniffer.js',
  'player-bridge.js',
  'styles.css',
  'popup.html',
  'popup.js',
  'icons',
];

const GECKO_ID = 'ytm-lyrics-plus@talhaaksoy.dev';
// `world: "MAIN"` in manifest content_scripts (sniffer.js + player-bridge.js
// must share the page's realm) only exists on Firefox ≥128.
const GECKO_MIN = '128.0';

// manifest.json is the single source of truth (Chrome shape). Each target's
// manifest is derived here so the two can never drift apart.
function manifestFor(target) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (target === 'firefox') {
    // Firefox MV3 uses a non-persistent background page, not a service worker.
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN },
    };
  }
  return JSON.stringify(m, null, 2) + '\n';
}

// macOS litters folders with .DS_Store — keep dotfiles out of the packages.
function cleanDotfiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.')) fs.rmSync(p, { recursive: true, force: true });
    else if (e.isDirectory()) cleanDotfiles(p);
  }
}

function zipDir(srcDir, zipPath) {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Force -Path '${srcDir}\\*' -DestinationPath '${zipPath}'`,
    ]);
    return;
  }
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: srcDir });
}

function buildTarget(target) {
  const dir = path.join(DIST, target);
  const zipPath = path.join(DIST, `${target}-extension.zip`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  for (const item of SHIP) {
    fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestFor(target));
  cleanDotfiles(dir);
  zipDir(dir, zipPath);
  console.log(`✓ dist/${target}/  →  dist/${target}-extension.zip`);
}

const requested = process.argv.slice(2);
const targets = requested.length ? requested : ['chrome', 'firefox'];
for (const t of targets) {
  if (t !== 'chrome' && t !== 'firefox') {
    console.error(`unknown target "${t}" — use chrome, firefox, or no argument for both`);
    process.exit(1);
  }
}

fs.mkdirSync(DIST, { recursive: true });
for (const t of targets) buildTarget(t);

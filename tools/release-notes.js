'use strict';

/*
 * Prints the release notes for one version from .homeychangelog.json (Dutch first, then English).
 * Used by .github/workflows/release.yml.   Usage: node tools/release-notes.js 0.6.6
 */

const path = require('path');

const version = process.argv[2];
const changelog = require(path.join(__dirname, '..', '.homeychangelog.json'));
const entry = changelog[version];

if (!entry) {
  console.log(`Versie ${version}`);
  process.exit(0);
}
const lines = [];
if (entry.nl) lines.push('**Nederlands**', '', entry.nl, '');
if (entry.en) lines.push('**English**', '', entry.en, '');
lines.push('Installeren: download de broncode hieronder en voer in de map `npm install` en `homey app install` uit.');
console.log(lines.join('\n'));

#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for a semver (no leading v).
 * Usage: node scripts/changelog-release-notes.mjs 0.6.0
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('Usage: changelog-release-notes.mjs <version>');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = `## ${version}`;
const start = changelog.indexOf(heading);
if (start === -1) {
  console.error(`No section ${heading} in CHANGELOG.md`);
  process.exit(1);
}

const afterHeading = start + heading.length;
const next = changelog.indexOf('\n## ', afterHeading);
const section = changelog.slice(afterHeading, next === -1 ? changelog.length : next).trim();

const prevTag = previousVersion(changelog, version);
const compare = prevTag
  ? `\n\n**Full Changelog**: https://github.com/dvnold/fm-bench/compare/v${prevTag}...v${version}`
  : '';

process.stdout.write(`${section}${compare}\n`);

function previousVersion(text, current) {
  const versions = [...text.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
  const idx = versions.indexOf(current);
  if (idx === -1 || idx === versions.length - 1) return null;
  return versions[idx + 1];
}
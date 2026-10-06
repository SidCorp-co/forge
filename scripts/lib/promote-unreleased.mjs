#!/usr/bin/env node
// The step of scripts/cut-release.sh that turns `## [Unreleased]` into a version section: an empty
// `[Unreleased]` stays on top, the version heading and its one-line summary follow, and the body
// that sat under `[Unreleased]` follows the summary after exactly one blank line.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKER = '## [Unreleased]';

export function promoteUnreleased(src, version, date, headline) {
  const i = src.indexOf(MARKER);
  if (i === -1) throw new Error(`no \`${MARKER}\` heading to promote`);
  const body = src.slice(i + MARKER.length).replace(/^\n+/, '');
  return `${src.slice(0, i)}${MARKER}\n\n## [${version}] - ${date}\n\n${headline}\n\n${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, version, date, headline] = process.argv.slice(2);
  if (!path || !version || !date || !headline) {
    console.error(
      'promote-unreleased: usage: promote-unreleased.mjs <record> <version> <date> <headline>',
    );
    process.exit(2);
  }
  writeFileSync(path, promoteUnreleased(readFileSync(path, 'utf8'), version, date, headline));
}

#!/usr/bin/env node
// The step of scripts/cut-release.sh that writes a version section: every fragment under
// changelog.d/ becomes a bullet under its `###` section, the section goes above the newest released
// one, and the fragments are deleted so the release commit carries the move in one diff.

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DIGEST,
  FRAGMENT_DIR,
  fragmentFiles,
  readFragment,
  SECTIONS,
} from './changelog-fragments.mjs';

const RELEASED = /^## \[/m;

/**
 * One fragment as its bullet: a digest leads with the week it summarises and an entry that offers a
 * tour closes with it, both as HTML comments that render as nothing. No reader of them remains,
 * since What's new shows the release the instance serves rather than this record.
 */
function bullet(f) {
  if (f.section === DIGEST) return `- <!-- digest: ${f.week} --> ${f.entry}`;
  return f.tour ? `- ${f.entry} <!-- tour: ${f.tour} -->` : `- ${f.entry}`;
}

/**
 * The record with a `## [version] - date` section built from `fragments` (`{ file, text }` each).
 * Refuses by name a fragment that is not one, an empty release, and a record still carrying
 * `## [Unreleased]` — its entries would be left behind under a heading nothing promotes any more.
 */
export function assembleRelease(record, fragments, version, date, headline) {
  if (/^## \[Unreleased\]/m.test(record)) {
    throw new Error(
      `the record still carries \`## [Unreleased]\`; move its entries to ${FRAGMENT_DIR}/<name>.<section>.md and delete the heading`,
    );
  }
  if (fragments.length === 0)
    throw new Error(`no fragments under ${FRAGMENT_DIR}/ — nothing to release`);
  const read = fragments.map(({ file, text }) => ({ file, ...readFragment(file, text) }));
  const bad = read.filter((f) => f.problems.length > 0);
  if (bad.length > 0) {
    throw new Error(
      bad.map((f) => `${FRAGMENT_DIR}/${f.file} ${f.problems.join('; ')}`).join('\n'),
    );
  }
  const blocks = [DIGEST, ...SECTIONS]
    .map((section) => {
      const entries = read
        .filter((f) => f.section === section)
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((f) => bullet(f));
      return entries.length > 0 ? `### ${section}\n\n${entries.join('\n')}\n\n` : '';
    })
    .join('');
  const section = `## [${version}] - ${date}\n\n${headline}\n\n${blocks}`;
  const at = record.search(RELEASED);
  if (at === -1) return `${record.replace(/\n*$/, '\n\n')}${section.replace(/\n+$/, '\n')}`;
  return `${record.slice(0, at)}${section}${record.slice(at)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, dir, version, date, headline] = process.argv.slice(2);
  if (!path || !dir || !version || !date || !headline) {
    console.error(
      'assemble-release: usage: assemble-release.mjs <record> <fragment-dir> <version> <date> <headline>',
    );
    process.exit(2);
  }
  let files = [];
  try {
    files = fragmentFiles(readdirSync(dir)).sort();
  } catch {
    files = [];
  }
  const fragments = files.map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
  try {
    writeFileSync(
      path,
      assembleRelease(readFileSync(path, 'utf8'), fragments, version, date, headline),
    );
  } catch (err) {
    console.error(`assemble-release: ${err.message}`);
    process.exit(1);
  }
  for (const file of files) rmSync(join(dir, file));
  console.log(`${files.length}`);
}

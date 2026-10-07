/**
 * The build's refusal: `node dist/whats-new/check-changelog.js` parses the CHANGELOG.md this build
 * ships and exits non-zero naming the file, version and line of a section What's new cannot read.
 */

import { readFileSync } from 'node:fs';
import { changelogPath, isChangelogError, parseChangelog } from './changelog.js';

try {
  const path = changelogPath();
  const releases = parseChangelog(readFileSync(path, 'utf8'), 'CHANGELOG.md');
  console.log(`check-changelog: ${releases.length} releases read from ${path}`);
} catch (err) {
  console.error(`check-changelog: ${isChangelogError(err) ? err.message : String(err)}`);
  process.exit(1);
}

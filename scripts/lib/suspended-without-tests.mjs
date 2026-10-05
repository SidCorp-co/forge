import { spawnSync } from 'node:child_process';
import { TEST_FILE_RE } from './test-reachability.mjs';

// cm:hack ISS-172 until:QA phase on dev — the test suites are removed on dev, so the three gates
// that read test files have nothing to read. This ends itself when a tracked test file returns. The
// QA phase rewrites the suites against current source rather than restoring the removed ones, which
// have drifted (docs/proposals/the-removed-test-suites-are-rewritten-not-restored.md).
export function suspendedWithoutTests(root, line) {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return false;
  if (r.stdout.split('\n').some((f) => TEST_FILE_RE.test(f))) return false;
  console.log(`${line} — suspended on dev until the QA phase restores the tests (ISS-172)`);
  return true;
}

// cm:hack ISS-172 until:QA phase on dev — single tests return with their lanes before the suites do,
// so a gate whose own population (`count`) is still empty stays suspended until one of its files is
// back. Deleted with the hack above when the QA phase has rewritten the suites.
export function suspendedUntilReturned(count, line) {
  if (count > 0) return false;
  console.log(`${line} — suspended on dev until the QA phase restores the tests (ISS-172)`);
  return true;
}

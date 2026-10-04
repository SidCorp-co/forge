import { spawnSync } from 'node:child_process';
import { TEST_FILE_RE } from './test-reachability.mjs';

// cm:hack ISS-172 until:QA phase on dev — the test suites are removed on dev, so the three gates
// that read test files have nothing to read. This ends itself when a tracked test file returns.
export function suspendedWithoutTests(root, line) {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return false;
  if (r.stdout.split('\n').some((f) => TEST_FILE_RE.test(f))) return false;
  console.log(`${line} — suspended on dev until the QA phase restores the tests (ISS-172)`);
  return true;
}

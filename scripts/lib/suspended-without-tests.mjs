// cm:hack ISS-172 until:a test declaring `@gate-input whole-tree` returns on dev — the core integration
// suites are back, but no rewritten test reads the whole repository yet, so the whole-tree gate's own
// population (`count`) is still empty and it stays suspended until one of its files returns.
export function suspendedUntilReturned(count, line) {
  if (count > 0) return false;
  console.log(`${line} — suspended on dev until the QA phase restores the tests (ISS-172)`);
  return true;
}

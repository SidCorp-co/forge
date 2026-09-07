// How a check's outcome is rendered and counted.
//
// The marks are ISS-938's and the reasoning below is its; they live here rather
// than in verify.mjs so that both they and the tally have a runner. verify.mjs
// executes its whole run at import, so nothing inside it can be unit-tested.

// cm:guard five marks, and each one asserts exactly ONE thing. `red` and `FAIL` are statements ABOUT THE REPO — the rule is broken, or the checker's output could not be audited. `n/a` and `skip` are statements about THIS MACHINE and say nothing about the repo either way. Merging `n/a` into `FAIL` is what let a worktree with no node_modules report the relations gate as a rule this repo fails; merging `skip` into `ok` lets a check that never ran print as a pass. Neither may come back.
export const MARKS = {
  ran: (code) => (code === 0 ? 'ok  ' : code === 2 ? 'FAIL' : 'red '),
  blocked: () => 'n/a ',
  skipped: () => 'skip',
};

export function markFor(result) {
  return (MARKS[result.condition] ?? MARKS.ran)(result.code);
}

// cm:guard a skip and an n/a are counted as DID NOT RUN, never as passes — the row marks alone left the reader to total 22 lines by eye, and the line that gets read is the one at the bottom. A tally that folded either into `passed` would restate the exact merge the marks exist to prevent.
export function tally(results) {
  const t = { passed: 0, notRun: 0, red: 0 };
  for (const r of results) {
    if (r.condition === 'skipped' || r.condition === 'blocked') t.notRun += 1;
    else if (r.code === 0) t.passed += 1;
    else t.red += 1;
  }
  return t;
}

export function tallyLine(t) {
  const parts = [`${t.passed} passed`, `${t.notRun} did not run`];
  if (t.red) parts.push(`${t.red} red`);
  return parts.join(' · ');
}

// How a check's outcome is rendered and counted.
//
// The marks are ISS-938's and the reasoning below is its; they live here rather
// than in verify.mjs so that both they and the tally have a runner. verify.mjs
// executes its whole run at import, so nothing inside it can be unit-tested.

export const MARKS = {
  ran: (code) => (code === 0 ? 'ok  ' : code === 2 ? 'FAIL' : 'red '),
  blocked: () => 'n/a ',
  skipped: () => 'skip',
};

export function markFor(result) {
  return (MARKS[result.condition] ?? MARKS.ran)(result.code);
}

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

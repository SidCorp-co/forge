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

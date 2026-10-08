// What a check's exit status and output say about it. A red checker is a red even when it prints
// no scan count; only a run that claims success without one, or one that crashed, is refused.

const CRASHED = /^Node\.js v\d/m;

/** The row a check earns from how it ended. `baseRef` names what a scoped run measured against. */
export function verdictOf(check, status, out, baseRef) {
  if (status === 2) {
    return {
      ...check,
      code: 2,
      condition: 'blocked',
      out,
      why: 'could not run — the checker says so; its reason is below',
    };
  }

  if (check.skipIf?.test(out)) {
    return {
      ...check,
      code: status ?? 0,
      condition: 'skipped',
      out,
      note: `skipped — not reproducible here; \`${check.coveredBy}\` covers it in CI`,
    };
  }
  if (check.scanned) {
    const m = out.match(check.scanned);
    if (!m) {
      if (status === 1 && !CRASHED.test(out)) return { ...check, code: 1, out };
      return { ...check, code: 2, out, why: 'no file count in output — cannot prove it ran' };
    }
    const n = Number(m[1]);
    if (n === 0 && !check.scopeMayBeEmpty) {
      return { ...check, code: 2, out, why: 'scanned 0 files — a scope nobody could compute' };
    }
    // `out` is printed only for a non-zero exit, so a checker whose job is partly to report is
    // silent on exactly the runs meant to carry it onward unless `carries` names what to keep.
    const carried = check.carries ? out.match(check.carries)?.[1] : undefined;
    const note = n === 0 ? `no diff against ${baseRef} — nothing to scope` : carried;
    return { ...check, code: status ?? 1, out, files: n, note };
  }
  return { ...check, code: status ?? 1, out };
}

// The merge check's rules (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17): what a
// change must be before its checks count, which checks a merge needs, and the report the tracker
// records on the issue (`POST /api/issues/:id/merge-check`). `scripts/merge-check.mjs` runs them.

/** Every check a merge needs, in the order they run. Probes and review are the tracker's half. */
export const REQUIRED_CHECKS = [
  'rebased-on-base',
  'typecheck',
  'direct-tests',
  'integration-tests',
  'verify',
];

/** Named in every report as not run here, with the issue that builds each. */
export const NOT_RUN_HERE = [
  {
    name: 'probes',
    owner: 'ISS-469',
    why: 'kept probes are replayed by the tracker once they exist',
  },
  {
    name: 'review',
    owner: 'ISS-473',
    why: 'a review is recorded on the issue, not run by this check',
  },
];

/**
 * The refusal for a change whose base moved past it, or null. `tipInHead` is whether the base's
 * latest commit is an ancestor of HEAD: a change is checked only as it would land.
 */
export function behindRefusal({ branch, tip, head, tipInHead }) {
  if (tipInHead) return null;
  return (
    `MERGE_BEHIND_BASE: ${branch} is at ${tip.slice(0, 12)}, which ${head.slice(0, 12)} does not contain, ` +
    `so this change is behind its base and its checks would not describe what lands. Rebase it onto ` +
    `origin/${branch} (\`git fetch origin ${branch} && git rebase origin/${branch}\`) and run the merge check again.`
  );
}

/**
 * The refusal for a checkout whose files are not HEAD's, or null: the checks would run on files the
 * recorded commit does not hold. `status` is `git status --porcelain` output.
 */
export function dirtyRefusal(status) {
  const lines = status.split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const named = lines.slice(0, 5).map((l) => l.slice(3));
  const more = lines.length > 5 ? ', …' : '';
  return (
    `the checkout holds ${lines.length} change(s) HEAD does not (${named.join(', ')}${more}), so ` +
    'checks run here would not describe the commit they are recorded against. Commit or stash ' +
    'them, then run the merge check again.'
  );
}

/** The refusal for a change with nothing in it, or null. */
export function emptyRefusal({ branch, head, touched }) {
  if (touched.length) return null;
  return (
    `${head.slice(0, 12)} changes nothing against ${branch}: it is already the base's tip, so there is ` +
    'nothing to merge. A landing already on the base is checked with `--since <the commit before it>`.'
  );
}

/** A required check the run did not make, or null when every one was made. */
export function missingCheck(checks) {
  return REQUIRED_CHECKS.find((name) => !checks.some((c) => c.name === name)) ?? null;
}

/** The checks that ended red. */
export function redChecks(checks) {
  return checks.filter((c) => c.result === 'fail');
}

/** The body `POST /api/issues/:id/merge-check` takes, as this run made it. */
export function reportOf({ branch, baseSha, head, mode, touched, checks }) {
  return {
    base: { branch, sha: baseSha },
    head,
    mode,
    touched,
    checks,
  };
}

// The merge check's rules (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17): what a
// change must be before its checks count, which checks a merge needs, and the report the tracker
// records on the issue (`POST /api/issues/:id/merge-check`). `scripts/merge-check.mjs` runs them.

import { LANDED_SINCE } from './base-branch.mjs';

/**
 * Every check a merge needs, in the order they run. `probes` is the issue's kept probes, run against
 * the change (`lib/merge-probes.mjs`); the review is the tracker's half, which the mark asks.
 */
export const REQUIRED_CHECKS = [
  'rebased-on-base',
  'typecheck',
  'direct-tests',
  'integration-tests',
  'probes',
  'verify',
];

/**
 * The fast lane's checks (REQ-39 BC-7): a change a person approved in its live preview, whose files
 * core classifies fast, lands with these alone. Copied from the contract's `FAST_LANE_MERGE_CHECKS`
 * because a script reads no TypeScript; `lib/merge-check.test.mjs` holds the copy to it.
 */
export const FAST_LANE_CHECKS = ['rebased-on-base', 'typecheck', 'direct-tests'];

/** The lanes `--lane` takes: `full` is every check above, `fast` the three the fast lane runs. */
export const LANES = ['full', 'fast'];

/** The checks a run on `lane` owes. */
export function requiredChecks(lane) {
  return lane === 'fast' ? FAST_LANE_CHECKS : REQUIRED_CHECKS;
}

/** What the fast lane leaves to the nightly suite and the release cut, said in its report. */
export function notRunOnLane(lane) {
  if (lane !== 'fast') return [];
  return REQUIRED_CHECKS.filter((n) => !FAST_LANE_CHECKS.includes(n)).map((name) => ({
    name,
    owner: 'REQ-39 BC-7',
    why:
      name === 'probes'
        ? 'the fast lane runs the typecheck and the touched tests only, and no kept probe'
        : 'the fast lane runs the typecheck and the touched tests only; the whole suite runs nightly and at each cut',
  }));
}

/**
 * The patch id `git patch-id --stable` printed for the change, or the refusal naming why there is
 * none. Every report carries it: core holds a fast one to the patch id the approved preview served,
 * and matches a reporter's confirm to it on either lane (REQ-41 BC-20); a full-lane report
 * without one is still taken by core, under a priced amnesty (scripts/README.md, merge-check row).
 */
export function patchIdOf(printed) {
  const id = printed.trim().split(/\s+/)[0] ?? '';
  if (/^[0-9a-f]{40}$/.test(id)) return { id };
  return {
    refusal:
      '`git patch-id --stable` printed no id for the change, so core has nothing to match a ' +
      "reporter's confirm or an approved preview to; a change with no diff has nothing to merge",
  };
}

/** Named in every report as not run here, with what owns each. */
export const NOT_RUN_HERE = [
  {
    name: 'review',
    owner: 'POST /api/issues/:id/review',
    why: 'another run reviews the diff against its patterns, rerunning nothing, and the mark asks it',
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

/** A check `lane` needs that the run did not make, or null when every one was made. */
export function missingCheck(checks, lane = 'full') {
  return requiredChecks(lane).find((name) => !checks.some((c) => c.name === name)) ?? null;
}

/**
 * The checks that ended red, a probe's excepted: a red probe is refused MERGE_PROBE_RED by name
 * (`lib/merge-probes.mjs:probeRefusalLines`), as core refuses it.
 */
export function redChecks(checks) {
  return checks.filter((c) => c.result === 'fail' && c.kind !== 'probes');
}

/**
 * The body `POST /api/issues/:id/merge-check` takes, as this run made it. `probes` binds each probe
 * check to the kept probe it ran, which core holds to the probes the issue keeps.
 */
export function reportOf({
  branch,
  baseSha,
  head,
  mode,
  touched,
  checks,
  probes = [],
  lane = 'full',
  patchId,
}) {
  return {
    base: { branch, sha: baseSha },
    head,
    mode,
    touched,
    checks,
    probes,
    lane,
    patchId,
  };
}

/**
 * What a passing run says it is owed next. A pre-merge run is recorded on the issue before the
 * merge mark; a landed run (`--since`, dev's push run) checks what already landed, so it asks for
 * nothing before a mark that has, or has not, already been made.
 */
export function passedMessage({ mode, branch, baseSha, head, path }) {
  if (mode === 'landed') {
    return (
      `merge-check: passed on a landing already on ${branch} (${baseSha.slice(0, 12)}..${head.slice(0, 12)}).\n` +
      `This checked what landed, after the merge; the report says what it ran:\n  ${path}`
    );
  }
  return (
    'merge-check: passed. Record it on the issue before the merge mark, with the report as the body:\n' +
    `  POST /api/issues/<issue id>/merge-check   < ${path}`
  );
}

/**
 * The environment `pnpm verify` runs under inside the merge check. It names the base branch, and on a
 * landing already on it (`--since`) the commit the landing was made on, so verify's delta-scoped
 * gates (`check-runner-gates.mjs`, `check-migration-order.mjs`, the baseline ratchets) measure
 * `<since>..HEAD`. Without it the base branch's tip is HEAD itself and each scope is empty — a
 * landed run then passed fmt, clippy, lockfile sync and migration order over nothing (ISS-472
 * round 3).
 */
export function verifyEnv({ branch, since, env }) {
  const out = { ...env, GITHUB_BASE_REF: branch };
  delete out[LANDED_SINCE];
  if (since) out[LANDED_SINCE] = since;
  return out;
}

/** The command line a report records for that verify run. */
export function verifyCommand({ branch, since }) {
  return `${since ? `${LANDED_SINCE}=${since} ` : ''}GITHUB_BASE_REF=${branch} pnpm verify`;
}

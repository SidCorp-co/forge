/**
 * Whether this pull request may be merged, decided from what GitHub reported.
 * ISS-1073.
 *
 * A pure function over three readings — the pull request, the base branch's
 * protection, and the check runs on the head — holding no database and making no
 * call, because the thing worth testing here is the decision and not the
 * fetching of it.
 *
 * ## Unknown is a refusal
 *
 * GitHub computes `mergeable` asynchronously: the first read after a push
 * answers `null` with `mergeable_state: "unknown"`, and a caller that reads
 * `null` as "no reason not to" merges a pull request nothing has checked. That
 * is the affordance this file exists to refuse, and it is why `mergeable: true`
 * is a positive condition here rather than `mergeable !== false`.
 *
 * ## One condition says yes, and everything else says no by name
 *
 * The merge arm is reached only when GitHub reports the pull request mergeable
 * on the head the caller named AND every check the base branch's protection
 * requires has concluded successfully on that head. Each other answer is its own
 * reason with its own sentence, because "cannot merge" tells an operator to go
 * and look and the four causes send them to four different places: rebase,
 * resolve, wait, or ask somebody.
 */
// cm:guard the required set is read off the BRANCH PROTECTION and not derived from the runs present on the head. A check that never started is absent from the head's runs, so deriving the set from what ran would make a missing required check look like a set with nothing missing — which is the silent pass this whole decision exists to refuse, arrived at from the safe-looking direction.
// cm:guard a required context satisfied only by a legacy COMMIT STATUS rather than a check run is reported here as absent, and the merge is refused. That is a stated bound and it is the safe direction: the cost is a refusal an operator has to override by merging by hand, where reading the combined-status endpoint as well would cost a call on every merge for a shape this repository does not use (`ci-passed` and every other required context on it is an Actions check run). If a project ever needs it, the fix is a second reading here and not a widening of the pass.

/** The pull request as GitHub answered for it, freshly read. */
export interface MergeReadout {
  number: number;
  /** `open` or `closed`, as GitHub spells it. */
  state: string;
  draft: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  headSha: string;
  baseRef: string;
  /** `true`, `false`, or `null` where GitHub has not computed it yet. */
  mergeable: boolean | null;
  /** `clean` | `dirty` | `behind` | `blocked` | `unstable` | `has_hooks` | `draft` | `unknown`. */
  mergeableState: string | null;
}

/** What the base branch's protection requires, or that Forge could not read it. */
export type ProtectionReadout =
  | { kind: 'unprotected' }
  | { kind: 'protected'; requiredChecks: string[] }
  | { kind: 'unreadable'; why: string };

/** One check run on the head, by the name a required context would name it. */
export interface HeadCheck {
  name: string;
  /** `queued` | `in_progress` | `completed`. */
  status: string;
  conclusion: string | null;
}

export type MergeRefusalReason =
  | 'already-merged'
  | 'not-open'
  | 'draft'
  | 'head-moved'
  | 'mergeability-uncomputed'
  | 'conflicting'
  | 'behind'
  | 'required-check'
  | 'protected-branch'
  | 'protection-unreadable';

export type MergeDecision =
  | { kind: 'merge' }
  | { kind: 'already-merged' }
  | { kind: 'refuse'; reason: Exclude<MergeRefusalReason, 'already-merged'>; detail: string };

// cm:guard GitHub's own rollup words, so Forge's answer agrees with the one on the pull request page. `neutral` and `skipped` are successes there and are successes here; `cancelled`, `timed_out` and `action_required` are failures. Inventing a fourth bucket makes an operator read two different answers about one check.
const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** The one check that answers for this required context, latest wins on the caller's ordering. */
function checkFor(checks: readonly HeadCheck[], context: string): HeadCheck | undefined {
  return checks.find((c) => c.name === context);
}

function requiredCheckFault(
  checks: readonly HeadCheck[],
  required: readonly string[],
): string | null {
  for (const context of required) {
    const run = checkFor(checks, context);
    if (!run) {
      return `the base branch requires the check \`${context}\` and nothing has reported it on this head — it has not started, or it is published under a different name`;
    }
    if (run.status !== 'completed') {
      return `the base branch requires the check \`${context}\` and it is still ${run.status} on this head`;
    }
    if (!SUCCESS_CONCLUSIONS.has(run.conclusion ?? '')) {
      return `the base branch requires the check \`${context}\` and it concluded \`${run.conclusion ?? 'with nothing'}\` on this head`;
    }
  }
  return null;
}

/**
 * The decision, in the order that gives an operator the most actionable answer.
 *
 * `expectedHeadSha` is the head the caller believed it was merging. Where it is
 * given and has moved, the merge is refused rather than made against whatever is
 * there now: somebody pushed between the decision and the call, and merging the
 * new commits is a different act from the one that was authorised.
 */
export function decideMerge(args: {
  pull: MergeReadout;
  protection: ProtectionReadout;
  headChecks: readonly HeadCheck[];
  expectedHeadSha?: string | undefined;
}): MergeDecision {
  const { pull, protection, headChecks } = args;

  if (pull.merged) return { kind: 'already-merged' };
  if (pull.state !== 'open') {
    return {
      kind: 'refuse',
      reason: 'not-open',
      detail: `pull request #${pull.number} is \`${pull.state}\` and was never merged, so there is nothing to merge`,
    };
  }
  if (pull.draft) {
    return {
      kind: 'refuse',
      reason: 'draft',
      detail: `pull request #${pull.number} is a draft — mark it ready for review before it can be merged`,
    };
  }
  if (args.expectedHeadSha && args.expectedHeadSha !== pull.headSha) {
    return {
      kind: 'refuse',
      reason: 'head-moved',
      detail: `the head of #${pull.number} is now ${pull.headSha} and this merge was authorised for ${args.expectedHeadSha} — somebody pushed, so the commits this would land are not the ones that were judged`,
    };
  }

  if (protection.kind === 'unreadable') {
    return {
      kind: 'refuse',
      reason: 'protection-unreadable',
      detail: `Forge cannot read what \`${pull.baseRef}\` requires (${protection.why}), so it cannot tell a satisfied protection from an unsatisfied one and will not merge on the difference`,
    };
  }

  // cm:guard uncomputed comes BEFORE every state-derived answer. GitHub computes `mergeable` in the background and answers `null` with `mergeable_state: "unknown"` on the first read after a push; reading that as anything but "ask again" is how a merge goes out against a pull request nothing has checked. The way out for a caller is to read again in a moment, which the refusal says.
  if (pull.mergeable === null || pull.mergeableState === 'unknown' || !pull.mergeableState) {
    return {
      kind: 'refuse',
      reason: 'mergeability-uncomputed',
      detail: `GitHub has not finished computing whether #${pull.number} can merge — it answers \`mergeable: ${String(pull.mergeable)}\`, \`mergeable_state: ${pull.mergeableState ?? 'nothing'}\`. That is not a no, and Forge will not read it as a yes; ask again in a moment`,
    };
  }

  if (pull.mergeableState === 'dirty' || pull.mergeable === false) {
    return {
      kind: 'refuse',
      reason: 'conflicting',
      detail: `#${pull.number} conflicts with \`${pull.baseRef}\` — GitHub reports \`mergeable_state: ${pull.mergeableState}\`. Resolve the conflict on the branch; nothing Forge can do from here merges it`,
    };
  }
  if (pull.mergeableState === 'behind') {
    return {
      kind: 'refuse',
      reason: 'behind',
      detail: `#${pull.number} is behind \`${pull.baseRef}\` and that branch requires branches to be up to date before merging — update the branch, which produces a new head and a new run of its checks`,
    };
  }

  const required = protection.kind === 'protected' ? protection.requiredChecks : [];
  const fault = requiredCheckFault(headChecks, required);
  if (fault) {
    return { kind: 'refuse', reason: 'required-check', detail: fault };
  }

  // cm:guard `blocked` reaches here only with every required CHECK green, so what is left is a protection rule that is not a check — a review that has not been approved, a code-owner who has not signed off, a conversation that is unresolved. Naming it as a failing check would send an operator to a log that says nothing is wrong.
  if (pull.mergeableState === 'blocked') {
    return {
      kind: 'refuse',
      reason: 'protected-branch',
      detail: `\`${pull.baseRef}\` is protected and #${pull.number} does not yet satisfy it — every required check has passed, so what is outstanding is a rule that is not a check: an approving review, a code owner, or an unresolved conversation. Forge merges as the App and will not bypass the protection`,
    };
  }

  if (pull.mergeable !== true) {
    return {
      kind: 'refuse',
      reason: 'protected-branch',
      detail: `GitHub reports \`mergeable: ${String(pull.mergeable)}\`, \`mergeable_state: ${pull.mergeableState}\` for #${pull.number}, which is not a state Forge merges on`,
    };
  }
  return { kind: 'merge' };
}

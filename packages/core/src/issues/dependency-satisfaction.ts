/**
 * ISS-868 — one implementation of "is this `blocks` blocker satisfied?", for
 * the read models that answer it in TypeScript. The dispatcher itself asks the
 * question in SQL (`dispatch-gates.ts`), so this file cannot be its source —
 * it is the mirror the mirrors share, which is one place to keep in step
 * instead of three.
 */

// cm:guard mirror `dispatch-gates.ts#blockedBy` EXACTLY — both arms. `merged_at` alone is not satisfaction: the stamp is COALESCE-once and never cleared, so a blocker that landed and was then bounced to `reopen` still reads merged while the gate holds the dependent. And `closed`-without-merge counts ONLY where the base branch is structurally unstampable; on an auto-advancing base a closed unmerged blocker means the code never landed.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — that predicate is the authority; a satisfaction arm added there and not here makes every read model report an issue as unblocked while the gate keeps it queued, which starved a dependent for 40min with a blank blocker banner before pipeline-health.ts grew its own copy of this rule
export function isBlockerSatisfied(
  blocker: { status: string | null; mergedAt: Date | null },
  baseStampable: boolean,
): boolean {
  if (blocker.mergedAt !== null && blocker.status !== 'reopen') return true;
  return !baseStampable && blocker.status === 'closed';
}

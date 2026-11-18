// The facts a release's turn is read from (`release-view.ts:turnOf`), out of one part of a release
// read and the facts the read shares: who owes what, what is in flight, and what its merges wait on.

import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { unmergedSteps } from './change-request-roster.js';
import { irreversibleOf, releaseOwesOf } from './release-owes.js';
import type { Part, Shared } from './release-read-views.js';
import { turnOf } from './release-view.js';

function inFlightStage(attempts: readonly ReleaseAttemptRow[]) {
  return [...attempts].reverse().find((a) => a.settledAt === null)?.stage ?? null;
}

export function approvalFacts(p: Part) {
  const latest = p.approvals[0];
  return latest
    ? {
        decision: latest.decision,
        requestedBy: latest.requestedBy,
        reason: latest.reason,
        decidedBy: latest.decidedBy,
      }
    : null;
}

/** What the release's issues do that cannot be undone, as their notes say it. */
export const irreversibleIn = (p: Part, s: Shared): string[] =>
  irreversibleOf(p.issueIds.map((id) => s.facts.issues.get(id)?.releaseNotes));

/** How many carried criteria a release proves of how many, and what its skips name (`unreachedOf`). */
type Weighed = { proven: number; total: number; unreached: readonly string[] | null };

/** The roster issues of a change-request release holding no merge mark, by key (ISS-1333). */
const unmarkedIn = (p: Part, s: Shared): string[] =>
  p.mergeSteps
    ? p.issueIds.flatMap((id) => {
        const issue = s.facts.issues.get(id);
        return issue && issue.merged.at === null ? [issue.key] : [];
      })
    : [];

export function turnFor(p: Part, s: Shared, criteria: Weighed) {
  return turnOf({
    state: p.state,
    version: p.version,
    projectId: s.projectId,
    runId: p.runId,
    // only a request not merged yet is a merge owed (ISS-1207), as its own row reads it (ISS-1333);
    // at none the settle's own wait reads
    merges: p.mergeSteps ? unmergedSteps(p.mergeSteps, s.mergeStates ?? new Map()).length : null,
    promotion: Boolean((p.runMetadata as { promotion?: unknown } | null | undefined)?.promotion),
    unmarked: unmarkedIn(p, s),
    landedOn: p.landedOn,
    released: s.facts.released,
    required: s.required,
    production: s.production === true,
    approval: approvalFacts(p),
    approvers: s.approvers,
    admins: s.admins,
    // a required approval that stands, on the draft or on the cut run, frees what waited on it
    owes: releaseOwesOf(
      s.policy,
      irreversibleIn(p, s),
      p.draftApproval?.decision === 'approved' || approvalFacts(p)?.decision === 'approved',
    ),
    viewer: s.viewer,
    gates: p.gates.filter((g) => g.kind === 'blocker'),
    inFlight: inFlightStage(p.attempts),
    prodConfirm: p.prodConfirm ?? null,
    confirmsProduction: s.confirmsProduction === true,
    testing: s.facts.judgedOn
      ? {
          environment: s.facts.judgedOn,
          judge: s.facts.judge,
          proven: criteria.proven,
          total: criteria.total,
          unreached: criteria.unreached,
        }
      : null,
  });
}

import type { ReleaseDetail } from '@forge/contracts/releases';
import { sayEn } from '@forge/contracts/said';

/**
 * The one release as the assistant reads it, with every attempt at it: what each was cut with, the
 * refusal that ended it (code, meaning, words) and the abort reason or carried note, so "why was
 * 0.4.0 cancelled" is answered from the record. `attempt` is the one wearing the asked version.
 */
export function releaseToolView(r: ReleaseDetail) {
  const attempts = r.cuts.map((c) => ({
    n: c.n,
    version: c.version,
    outcome: c.outcome,
    cutAt: c.cutAt,
    endedAt: c.endedAt,
    endedBy: c.decidedBy?.name ?? null,
    refusal: c.refusal
      ? { code: c.refusal.code, meaning: sayEn(c.refusal.says), text: c.refusal.text }
      : null,
    abortReason: c.abortReason,
    carried: c.carried,
    roster: c.roster.map((i) => i.key),
  }));
  return {
    version: r.version,
    state: r.state,
    releasedAt: r.releasedAt,
    continuedAs: r.continuedAs,
    attempt: attempts.find((a) => a.version === r.version) ?? null,
    attempts,
    name: r.name,
    summary: r.summary,
    verified: r.verified,
    verifiedBy: r.verifiedBy,
    whatUsersGet: r.notes.sections,
    designsApproved: r.notes.designs,
    withoutNotes: r.notes.withoutNotes,
    internal: r.notes.skipped,
    reworked: r.notes.reworked,
    requirements: r.requirementsCompleted,
    issues: r.issues.map((i) => ({
      key: i.key,
      title: i.title,
      status: i.status,
      requirement: i.requirement,
      proof: i.proof,
    })),
    feedbackAnswered: r.feedbackAnswered,
    gates: r.gates.map((g) => ({
      code: g.code,
      kind: g.kind,
      sentence: g.sentence,
      owner: g.owner,
    })),
    approval: r.approval,
    waitingOn: r.waitingOn,
  };
}

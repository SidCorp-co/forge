import { type Db, db } from '../db/client.js';
import { findMissingWorkEvidence } from '../pipeline/work-evidence.js';
import type { ActorAgency } from './actor-agency.js';
import type { TransitionIssueRow } from './apply-transition.js';
import type { LegacyRung } from './legacy-status.js';

export interface TransitionEvidenceViolation {
  code: 'NO_WORK_EVIDENCE';
  detail: string;
  details: Record<string, unknown>;
}

export const isBlankPlan = (plan: string | null | undefined): boolean =>
  !plan || plan.trim().length === 0;

const CLAIMS_CODE: ReadonlySet<LegacyRung> = new Set(['developed', 'testing']);

/**
 * cm:hack ISS-786 child B, carried onto the retired rungs a 17-status caller still names
 * (`legacy-status.ts`): an agent naming `developed` or `testing` with no branch, commit or handoff
 * recorded is refused NO_WORK_EVIDENCE, as it was when those were statuses. A person's hand-advance
 * is exempt, as before. Exit: until forge-plugin moves to the 10-status model (plugin-followups.md).
 */
export async function legacyRungEvidenceFault(args: {
  issue: Pick<TransitionIssueRow, 'id'>;
  rung: LegacyRung | null;
  agency: ActorAgency;
  executor?: Pick<Db, 'select'>;
}): Promise<TransitionEvidenceViolation | null> {
  if (args.rung === null || !CLAIMS_CODE.has(args.rung) || args.agency !== 'agent') return null;
  const detail = await findMissingWorkEvidence(args.issue.id, args.executor ?? db);
  if (!detail) return null;
  return {
    code: 'NO_WORK_EVIDENCE',
    detail,
    details: { issueId: args.issue.id, rung: args.rung },
  };
}

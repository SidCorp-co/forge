// A reopen's cause (ISS-927, REQ-67 BC-6): a reopen naming `cause: defect` with its evidence is a
// defect stall on the issue (`stalls.ts:stallsOfMove` starts it), decided by that field alone and
// never by reading the reason. Kernel input: a cause off a reopen, a defect without its proof, a proof
// without its cause, and a proof that is not on the issue are each refused by name before the move.

import type { IssueTransitionRefusalCode } from '@forge/contracts/issue-machine';
import type { DefectEvidence, ReopenCause } from '@forge/contracts/stalls';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { commentAttachments, comments, type IssueStatus, issueAttachments } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';

export interface ReopenCauseInput {
  cause?: ReopenCause | undefined;
  evidence?: DefectEvidence | undefined;
}

export interface ReopenCauseFault {
  code: Extract<
    IssueTransitionRefusalCode,
    | 'CAUSE_NOT_APPLICABLE'
    | 'DEFECT_EVIDENCE_REQUIRED'
    | 'DEFECT_CAUSE_REQUIRED'
    | 'DEFECT_EVIDENCE_NOT_FOUND'
  >;
  detail: string;
  details: Record<string, unknown>;
}

const PLAIN_REOPEN = 'a reopen naming neither is a plain reopen and starts no stall';
const DEFECT_SHAPE =
  '`cause: "defect"` with `evidence` naming one proof: `{"verdictId"}`, `{"attachmentId"}` or `{"liveRead"}`';

/** The fault in a move's cause and evidence that needs no read, or null. Pure: the unit test's subject. */
export function reopenCauseShapeFault(
  to: IssueStatus,
  input: ReopenCauseInput,
): ReopenCauseFault | null {
  const named = [input.cause && 'cause', input.evidence && 'evidence'].filter(Boolean);
  if (named.length === 0) return null;
  if (to !== 'reopen') {
    return {
      code: 'CAUSE_NOT_APPLICABLE',
      detail: `${named.map((k) => `\`${k}\``).join(' and ')} ${named.length > 1 ? 'are' : 'is'} taken only by a move to \`reopen\`, and this one is to \`${to}\`. Say why in \`reason\` instead.`,
      details: { to, fields: named },
    };
  }
  if (input.cause === 'defect' && !input.evidence) {
    return {
      code: 'DEFECT_EVIDENCE_REQUIRED',
      detail: `a reopen naming \`cause: "defect"\` cites its proof in \`evidence\`, and this one names none. Send ${DEFECT_SHAPE}; ${PLAIN_REOPEN}.`,
      details: { to, cause: input.cause },
    };
  }
  if (input.evidence && !input.cause) {
    return {
      code: 'DEFECT_CAUSE_REQUIRED',
      detail: `\`evidence\` is the proof of a defect, and this reopen names no \`cause\`. Send ${DEFECT_SHAPE}; ${PLAIN_REOPEN}.`,
      details: { to },
    };
  }
  return null;
}

/** Whether the verdict or attachment the evidence names is on the issue; a live read is the caller's word. */
async function evidenceOnIssue(issueId: string, evidence: DefectEvidence): Promise<boolean> {
  if ('liveRead' in evidence) return true;
  if ('verdictId' in evidence) {
    const [row] = await db
      .select({ id: criterionVerdicts.id })
      .from(criterionVerdicts)
      .where(
        and(eq(criterionVerdicts.id, evidence.verdictId), eq(criterionVerdicts.issueId, issueId)),
      )
      .limit(1);
    return Boolean(row);
  }
  const [own] = await db
    .select({ id: issueAttachments.id })
    .from(issueAttachments)
    .where(
      and(eq(issueAttachments.id, evidence.attachmentId), eq(issueAttachments.issueId, issueId)),
    )
    .limit(1);
  if (own) return true;
  const [onComment] = await db
    .select({ id: commentAttachments.id })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(and(eq(commentAttachments.id, evidence.attachmentId), eq(comments.issueId, issueId)))
    .limit(1);
  return Boolean(onComment);
}

/**
 * The refusal a move's cause and evidence earn, or null; and where it names a defect, the defect the
 * move starts. Read before the move's transaction, as the archive and work-state reads are.
 */
export async function reopenCauseOf(
  issueId: string,
  to: IssueStatus,
  input: ReopenCauseInput,
): Promise<{ fault: ReopenCauseFault } | { defect: { evidence: DefectEvidence } | null }> {
  const fault = reopenCauseShapeFault(to, input);
  if (fault) return { fault };
  if (input.cause !== 'defect' || !input.evidence) return { defect: null };
  if (!(await evidenceOnIssue(issueId, input.evidence))) {
    const [kind, id] = Object.entries(input.evidence)[0] as [string, string];
    const what = kind === 'verdictId' ? 'verdict' : 'attachment';
    return {
      fault: {
        code: 'DEFECT_EVIDENCE_NOT_FOUND',
        detail: `\`evidence.${kind}\` names ${what} ${id}, and no ${what} by that id is on this issue${what === 'attachment' ? ' or its comments' : ''}. Cite one recorded on it, or the live read in \`{"liveRead"}\`.`,
        details: { evidence: input.evidence },
      },
    };
  }
  return { defect: { evidence: input.evidence } };
}

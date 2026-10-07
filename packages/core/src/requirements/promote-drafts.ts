/**
 * The act that answers a requirement's "promote N draft issues": a holder of requirements.approve
 * moves its draft issues `draft → open`, all of them or the ones named (FB-93). A breakdown accept
 * files its issues at draft on purpose (`suggestions/breakdown.ts`); this is the separate, visible
 * take-on the owner kept. Each issue moves through its own status move (`issues/apply-transition.ts`),
 * so each keeps its guards, its record and its event; a refused one is named and the rest still move.
 */

import {
  draftIssuesToPromote,
  type PromoteDraftsAnswer,
  type PromotedDraftIssue,
  type RefusedDraftIssue,
  requirementKey,
} from '@forge/contracts/requirements';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import type { RequirementStatus } from '../db/schema-requirements.js';
import { activeIssuePrefix, transitionIssueStatus } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { isRefusal } from '../lib/refusal.js';
import { detailOf, type RequirementActor, rowIn, signerRefusal } from './read.js';
import { deferredRefusal, type RequirementRefusal } from './rules.js';

export interface DraftCandidate {
  id: string;
  displayId: string;
  status: string;
}

type PromoteRefusal = Omit<RequirementRefusal, 'code'> & { code: string };

export type PromoteOutcome =
  | ({ ok: true } & PromoteDraftsAnswer)
  | { ok: false; refusals: PromoteRefusal[] };

/**
 * Which linked issues a promote moves, or why it moves none: pure over what was read. Named refs are
 * matched by uuid or key against the requirement's own issues; each one not linked, or linked and
 * not at draft, is refused at its place in the request.
 */
export function promoteSelection<T extends DraftCandidate>(input: {
  status: RequirementStatus;
  key: string;
  linked: readonly T[];
  named: readonly string[] | undefined;
}): { ok: true; drafts: T[] } | { ok: false; refusals: RequirementRefusal[] } {
  const deferred = deferredRefusal(input.status, 'promoting its draft issues');
  if (deferred) return { ok: false, refusals: [deferred] };
  if (input.status !== 'agreed' && input.status !== 'accepted') {
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_NOT_AGREED',
          path: '',
          detail: `${input.key} is ${input.status}; only an agreed or accepted requirement has issues to promote.`,
        },
      ],
    };
  }
  const promotable = draftIssuesToPromote(input.status, input.linked);
  if (!input.named) {
    if (promotable.length > 0) return { ok: true, drafts: promotable };
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_NO_DRAFT_ISSUES',
          path: '',
          detail: `${input.key} has no linked issue at draft, so there is nothing to promote.`,
        },
      ],
    };
  }
  const refusals: RequirementRefusal[] = [];
  const drafts: T[] = [];
  input.named.forEach((ref, at) => {
    const wanted = ref.trim().toLowerCase();
    const issue = input.linked.find(
      (i) => i.id.toLowerCase() === wanted || i.displayId.toLowerCase() === wanted,
    );
    if (!issue) {
      refusals.push({
        code: 'REQUIREMENT_ISSUE_NOT_LINKED',
        path: `/issues/${at}`,
        detail: `${ref} is not an issue linked to ${input.key}; name one of its own issues by key or uuid.`,
      });
    } else if (issue.status !== 'draft') {
      refusals.push({
        code: 'REQUIREMENT_ISSUE_NOT_DRAFT',
        path: `/issues/${at}`,
        detail: `${issue.displayId} is at ${issue.status}, not draft; only a draft is promoted.`,
      });
    } else if (!drafts.includes(issue)) {
      drafts.push(issue);
    }
  });
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, drafts };
}

export async function promoteDraftIssues(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  issues?: readonly string[] | undefined;
}): Promise<PromoteOutcome> {
  const { projectId, actor } = input;
  const row = await rowIn(db, projectId, input.ref);
  const signer = await signerRefusal(
    actor,
    projectId,
    "promoting a requirement's draft issues",
    row,
  );
  if (signer) return { ok: false, refusals: [signer] };
  const prefix = await activeIssuePrefix(projectId);
  const linked = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(eq(issues.requirementId, row.id))
    .orderBy(asc(issues.issSeq));
  const candidates = linked.map((i) => ({
    ...i,
    displayId: formatIssueRef(prefix, i.issSeq),
  }));
  const key = requirementKey(row.reqSeq);
  const picked = promoteSelection({
    status: row.status as RequirementStatus,
    key,
    linked: candidates,
    named: input.issues,
  });
  if (!picked.ok) return picked;

  const promoted: PromotedDraftIssue[] = [];
  const refused: RefusedDraftIssue[] = [];
  for (const issue of picked.drafts) {
    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId,
          status: issue.status as IssueStatus,
          reopenCount: issue.reopenCount,
        },
        'open',
        { type: 'user', id: actor.userId, agency: actor.agency },
        { reason: `promoted from ${key}` },
      );
      promoted.push({ issueId: issue.id, displayId: issue.displayId });
    } catch (err) {
      if (!isRefusal(err)) throw err;
      for (const r of err.refusals) {
        refused.push({
          issueId: issue.id,
          displayId: issue.displayId,
          code: r.code,
          detail: r.detail,
        });
      }
    }
  }
  if (promoted.length === 0) {
    return {
      ok: false,
      refusals: refused.map((r) => ({
        code: r.code,
        path: `/issues/${r.displayId}`,
        detail: `${r.displayId}: ${r.detail}`,
      })),
    };
  }
  const requirement = await detailOf(await rowIn(db, projectId, row.id), actor);
  return { ok: true, requirement, promoted, refused };
}

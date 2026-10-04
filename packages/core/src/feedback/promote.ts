import {
  FEEDBACK_LIMITS,
  type FeedbackPromoteEffect,
  type FeedbackView,
  type PromoteAgentReportRequest,
} from '@forge/contracts/feedback';
import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentReports, issues, projects } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { assertProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { embedFeedbackLater } from './embeddings.js';
import { detailAs, type FeedbackActor, feedbackKey, notFound, rowIn } from './read.js';
import { promoteRefusal } from './rules.js';
import { decide, insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

export type PromoteOutcome =
  | { ok: true; feedback: FeedbackView; effect: FeedbackPromoteEffect }
  | { ok: false; refusals: NamedRefusal[] };

async function slugsOf(ids: string[]) {
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, ids));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

async function routedKeys(tx: Tx, id: string, lock: boolean) {
  const query = tx
    .select({
      projectId: agentReports.projectId,
      feedbackSeq: feedback.fbSeq,
      issueSeq: issues.issSeq,
      reviewedAt: agentReports.reviewedAt,
    })
    .from(agentReports)
    .leftJoin(feedback, eq(feedback.id, agentReports.feedbackId))
    .leftJoin(issues, eq(issues.id, agentReports.linkedIssueId))
    .where(eq(agentReports.id, id));
  const [r] = lock ? await query.for('update', { of: agentReports }) : await query;
  if (!r) throw notFound(`agent report ${id} is gone`);
  const prefix = r.issueSeq === null ? null : await activeIssuePrefix(r.projectId);
  return {
    feedbackKey: r.feedbackSeq === null ? null : feedbackKey(r.feedbackSeq),
    linkedIssueKey: r.issueSeq === null ? null : formatIssueRef(prefix, r.issueSeq),
    reviewedAt: r.reviewedAt,
  };
}

// cm:why ISS-93 (feedback-triage decision, 2026-10-04): promoting an agent report files feedback, so
// any member may do it, person or agent; the promoter is the item's reporter and verifies the fix.
// It is the report's review: an unreviewed report is stamped reviewed at the promotion, and the
// promoter is who reviewed it, recorded as the `promoted` decision row's decider; the report gets no
// reviewer column (that is ISS-77's triage). The text it copies is named on the answer and on that
// row, and the reference is kept on the report and read back on the item
export async function promoteAgentReport(input: {
  projectId: string;
  actor: FeedbackActor;
  request: PromoteAgentReportRequest;
}): Promise<PromoteOutcome> {
  const { projectId, actor, request } = input;
  await assertProjectAccess(projectId, actor.userId, 'member');
  const [report] = await db
    .select()
    .from(agentReports)
    .where(eq(agentReports.id, request.agentReport));
  const visible = report ? await loadVisibleProjectIds(actor.userId) : [];
  if (!report || !visible.includes(report.projectId)) {
    throw notFound(`no agent report ${request.agentReport} in any project you can see`);
  }
  const slugs = await slugsOf([projectId, report.projectId]);
  const facts = {
    reportId: report.id,
    reportProject: slugs.get(report.projectId) ?? report.projectId,
    project: slugs.get(projectId) ?? projectId,
  };
  const before = promoteRefusal({ ...facts, ...(await routedKeys(db, report.id, false)) });
  if (before) return { ok: false, refusals: [before] };
  const copied: FeedbackPromoteEffect['copied'] = [];
  if (request.title === undefined) copied.push('title');
  if (request.body === undefined) copied.push('body');
  const said = [report.detail, report.suggestion ? `Suggested: ${report.suggestion}` : null];
  const { agentReport: _source, ...asked } = request;
  const prepared = await preparedFeedback(projectId, actor, {
    ...asked,
    title: request.title ?? report.summary.slice(0, FEEDBACK_LIMITS.title),
    body: request.body ?? (said.filter(Boolean).join('\n\n') || undefined),
  });
  if (!prepared.ok) return prepared;
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const held = await routedKeys(tx, report.id, true);
    const refused = promoteRefusal({ ...facts, ...held });
    if (refused) return [refused];
    id = await insertFeedbackIn(tx, prepared.values);
    const ref = report.targetRef ? ` ${report.targetRef}` : '';
    await decide(tx, await rowIn(tx, projectId, id), actor, {
      decision: 'promoted',
      reason: `From agent report ${report.id} (${report.kind}, ${report.target}${ref}); ${
        copied.length ? `copied its ${copied.join(' and ')}` : 'nothing copied from it'
      }.`,
    });
    await tx
      .update(agentReports)
      .set({ feedbackId: id, ...(held.reviewedAt ? {} : { reviewedAt: new Date() }) })
      .where(eq(agentReports.id, report.id));
    return null;
  });
  if (refusals) return { ok: false, refusals };
  embedFeedbackLater(id);
  const view = await detailAs(actor, projectId, id);
  return {
    ok: true,
    feedback: view,
    effect: { feedback: view.key, agentReport: report.id, copied },
  };
}

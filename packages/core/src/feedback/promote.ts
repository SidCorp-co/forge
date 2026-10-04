import {
  FEEDBACK_LIMITS,
  type FeedbackPromoteEffect,
  type FeedbackView,
  type PromoteAgentReportRequest,
} from '@forge/contracts/feedback';
import { eq, inArray } from 'drizzle-orm';
import { alreadyTriagedRefusal, type TriageFacts } from '../agent-reports/rules.js';
import { markReportFiled } from '../agent-reports/service.js';
import { db, type Tx } from '../db/client.js';
import { agentReports, issues, projects } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import type { Refusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { embedFeedbackLater } from './embeddings.js';
import { detailAs, type FeedbackActor, feedbackKey, notFound, rowIn } from './read.js';
import { promoteRefusal } from './rules.js';
import { decide, insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

export type PromoteOutcome =
  | { ok: true; feedback: FeedbackView; effect: FeedbackPromoteEffect }
  | { ok: false; refusals: Refusal[] };

async function slugsOf(ids: string[]) {
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, ids));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

async function routedKeys(tx: Tx, id: string, lock: boolean): Promise<TriageFacts> {
  const query = tx
    .select({
      projectId: agentReports.projectId,
      feedbackSeq: feedback.fbSeq,
      issueSeq: issues.issSeq,
      issueProjectId: issues.projectId,
      triage: agentReports.triage,
      triagedAt: agentReports.triagedAt,
      triageReason: agentReports.triageReason,
      duplicateOf: agentReports.duplicateOf,
      triagedBy: agentReports.triagedBy,
    })
    .from(agentReports)
    .leftJoin(feedback, eq(feedback.id, agentReports.feedbackId))
    .leftJoin(issues, eq(issues.id, agentReports.linkedIssueId))
    .where(eq(agentReports.id, id));
  const [r] = lock ? await query.for('update', { of: agentReports }) : await query;
  if (!r) throw notFound(`agent report ${id} is gone`);
  const prefix =
    r.issueSeq === null || !r.issueProjectId ? null : await activeIssuePrefix(r.issueProjectId);
  return {
    id,
    projectId: r.projectId,
    triage: r.triage,
    triagedByName: r.triagedBy
      ? ((await peopleOf([r.triagedBy])).get(r.triagedBy)?.name ?? null)
      : null,
    triagedAt: r.triagedAt,
    triageReason: r.triageReason,
    duplicateOf: r.duplicateOf,
    feedbackKey: r.feedbackSeq === null ? null : feedbackKey(r.feedbackSeq),
    linkedIssueKey: r.issueSeq === null ? null : formatIssueRef(prefix, r.issueSeq),
  };
}

/** The ISS-93 codes name a report already routed; any other triage is a second triage (ISS-113). */
function promoteRefusals(
  facts: { reportId: string; reportProject: string; project: string },
  held: TriageFacts,
) {
  return promoteRefusal({ ...facts, ...held }) ?? alreadyTriagedRefusal(held);
}

// cm:why ISS-93 (feedback-triage decision, 2026-10-04): promoting an agent report files feedback, so
// any member may do it, person or agent; the promoter is the item's reporter and verifies the fix.
// It is the report's triage (ISS-113, design automation's filed-target decision): the report becomes
// filed, with the feedback item as its one target and the promoter as triagedBy, in the write that
// links it. The text it copies is named on the answer and on the `promoted` decision row
export async function promoteAgentReport(input: {
  projectId: string;
  actor: FeedbackActor;
  request: PromoteAgentReportRequest;
}): Promise<PromoteOutcome> {
  const { projectId, actor, request } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
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
  const before = promoteRefusals(facts, await routedKeys(db, report.id, false));
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
    const refused = promoteRefusals(facts, held);
    if (refused) return [refused];
    id = await insertFeedbackIn(tx, prepared.values);
    const ref = report.targetRef ? ` ${report.targetRef}` : '';
    await decide(tx, await rowIn(tx, projectId, id), actor, {
      decision: 'promoted',
      reason: `From agent report ${report.id} (${report.kind}, ${report.target}${ref}); ${
        copied.length ? `copied its ${copied.join(' and ')}` : 'nothing copied from it'
      }.`,
    });
    await markReportFiled(tx, report.id, { feedbackId: id, by: actor.userId, agency: actor.agency });
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

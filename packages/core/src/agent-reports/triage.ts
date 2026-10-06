/**
 * Triage of agent reports: every act from either door, the issue-delete guard
 * while reports are filed into an issue, and a report promoted to feedback.
 */

import type {
  AgentReportTriage,
  AgentReportTriageEffect,
  TriageAgentReportRequest,
} from '@forge/contracts/agent-reports';
import { feedbackKey } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentReports, issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { activeIssuePrefix, writeRecordEvent } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import type { Refusal } from '../lib/refusal.js';
import { fileIssueIn, type IssueChannel } from './file.js';
import { bulkMoves, filedIntoIssueRefusal, type TriageFacts, triageRefusals } from './rules.js';

export interface ReportActor {
  userId: string;
  agency: ActorAgency;
}

async function lockedFacts(tx: Tx, scope: SQL[]) {
  const rows = await tx
    .select({
      id: agentReports.id,
      projectId: agentReports.projectId,
      triage: agentReports.triage,
      triagedAt: agentReports.triagedAt,
      triageReason: agentReports.triageReason,
      duplicateOf: agentReports.duplicateOf,
      triagedBy: agentReports.triagedBy,
      issueSeq: issues.issSeq,
      issueProjectId: issues.projectId,
      feedbackSeq: feedback.fbSeq,
      summary: agentReports.summary,
      detail: agentReports.detail,
      suggestion: agentReports.suggestion,
      kind: agentReports.kind,
      severity: agentReports.severity,
      target: agentReports.target,
      targetRef: agentReports.targetRef,
    })
    .from(agentReports)
    .leftJoin(issues, eq(issues.id, agentReports.linkedIssueId))
    .leftJoin(feedback, eq(feedback.id, agentReports.feedbackId))
    .where(and(...scope))
    .orderBy(asc(agentReports.createdAt), asc(agentReports.id))
    .for('update', { of: agentReports });
  const people = await peopleOf(rows.map((r) => r.triagedBy));
  const prefixes = new Map<string, string | null>();
  for (const r of rows) {
    if (r.issueProjectId && !prefixes.has(r.issueProjectId))
      prefixes.set(r.issueProjectId, await activeIssuePrefix(r.issueProjectId));
  }
  return rows.map((r) => ({
    ...r,
    facts: {
      id: r.id,
      projectId: r.projectId,
      triage: r.triage,
      triagedByName: r.triagedBy ? (people.get(r.triagedBy)?.name ?? null) : null,
      triagedAt: r.triagedAt,
      triageReason: r.triageReason,
      duplicateOf: r.duplicateOf,
      linkedIssueKey:
        r.issueSeq === null || !r.issueProjectId
          ? null
          : formatIssueRef(prefixes.get(r.issueProjectId) ?? null, r.issueSeq),
      feedbackKey: r.feedbackSeq === null ? null : feedbackKey(r.feedbackSeq),
    } satisfies TriageFacts,
  }));
}
const TO: Record<TriageAgentReportRequest['act'], AgentReportTriage> = {
  file: 'filed',
  dismiss: 'dismissed',
  duplicate: 'duplicate',
  reopen: 'new',
};

export type TriageOutcome =
  | { ok: true; effect: AgentReportTriageEffect }
  | { ok: false; refusals: Refusal[] };

// design automation rev 1 (steps triage, file, dismiss; REQ-16 BC-3): every triage act, from
// either door, single or by signal, is this one write: the reports are locked, every rule is read
// before anything is written, a file creates its draft issue in the same transaction, and each row
// carries its own triagedBy. A bulk act moves the reports its act applies to and names the rest
export async function triageReports(input: {
  scope: SQL[];
  bulk: boolean;
  act: TriageAgentReportRequest;
  actor: ReportActor;
  channel: IssueChannel;
  linkIssue: { id: string; key: string } | null;
}): Promise<TriageOutcome> {
  const { act, actor } = input;
  return db.transaction(async (tx) => {
    const locked = await lockedFacts(tx, input.scope);
    let original: { id: string; projectId: string } | null = null;
    if (act.act === 'duplicate') {
      const [o] = await tx
        .select({ id: agentReports.id, projectId: agentReports.projectId })
        .from(agentReports)
        .where(eq(agentReports.id, act.duplicateOf));
      original = o ?? null;
    }
    const moving = input.bulk ? locked.filter((r) => bulkMoves(r.facts, act)) : locked;
    const untouched = locked
      .filter((r) => !moving.includes(r))
      .map((r) => ({ id: r.id, triage: r.triage }));
    const refusals = moving.flatMap((r) => triageRefusals(r.facts, act, original));
    if (refusals.length > 0) return { ok: false, refusals };
    const to = TO[act.act];
    if (moving.length === 0) {
      return {
        ok: true,
        effect: { act: act.act, triage: to, reports: [], issue: null, untouched },
      };
    }
    let issue: AgentReportTriageEffect['issue'] = null;
    if (act.act === 'file') {
      issue = input.linkIssue
        ? { ...input.linkIssue, created: false }
        : await fileIssueIn(tx, moving, act.createIssue ?? {}, actor, input.channel);
    }
    const now = new Date();
    const triaged = act.act !== 'reopen';
    const ids = moving.map((r) => r.id);
    await tx
      .update(agentReports)
      .set({
        triage: to,
        triagedBy: triaged ? actor.userId : null,
        triagedAgency: triaged ? actor.agency : null,
        triagedAt: triaged ? now : null,
        triageReason:
          act.act === 'dismiss' || act.act === 'duplicate' ? (act.reason ?? null) : null,
        duplicateOf: act.act === 'duplicate' ? act.duplicateOf : null,
        linkedIssueId: issue ? issue.id : null,
      })
      .where(inArray(agentReports.id, ids));
    if (issue) await recordFiled(tx, issue, ids, actor);
    return {
      ok: true,
      effect: { act: act.act, triage: to, reports: ids, issue, untouched },
    };
  });
}

async function recordFiled(
  tx: Tx,
  issue: { id: string; created: boolean },
  reportIds: string[],
  actor: ReportActor,
) {
  await writeRecordEvent(
    {
      issueId: issue.id,
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
      kind: 'decision',
      contract: 1,
      fields: [
        {
          key: 'lead',
          value: `${reportIds.length} agent report(s) filed into this issue as its evidence`,
        },
        { key: 'agent-reports', value: reportIds.join(', ') },
        { key: 'outcome', value: issue.created ? 'filed' : 'linked' },
      ],
    },
    tx,
  );
}

/** The refusal an issue delete meets while reports are filed into it, else null. */
export async function issueDeleteRefusal(issue: {
  id: string;
  projectId: string;
  issSeq: number;
}): Promise<Refusal | null> {
  const rows = await db
    .select({ id: agentReports.id })
    .from(agentReports)
    .where(eq(agentReports.linkedIssueId, issue.id))
    .orderBy(asc(agentReports.createdAt));
  if (rows.length === 0) return null;
  const key = formatIssueRef(await activeIssuePrefix(issue.projectId), issue.issSeq);
  return filedIntoIssueRefusal(
    key,
    rows.map((r) => r.id),
  );
}

/** An agent report promoted to a feedback is triaged as filed, naming who filed it. */
export async function markReportFiled(
  tx: Tx,
  reportId: string,
  filed: { feedbackId: string; by: string; agency: ActorAgency },
): Promise<void> {
  await tx
    .update(agentReports)
    .set({
      feedbackId: filed.feedbackId,
      triage: 'filed',
      triagedBy: filed.by,
      triagedAgency: filed.agency,
      triagedAt: new Date(),
    })
    .where(eq(agentReports.id, reportId));
}

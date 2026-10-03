/**
 * What accepting a suggestion writes, kind by kind, inside the accept's transaction (workflow
 * `suggestion-lifecycle` rev 2: "its effect — a revision, issues, a triage — was written in the same
 * transaction and points back at it"). Each writer returns refusals that roll the accept back, or
 * the effect the caller reads back. A kind whose effect the approved designs leave undecided is
 * refused SUGGESTION_EFFECT_UNDECIDED rather than accepted with nothing written.
 */

import type { FeedbackTriageEffect } from '@forge/contracts/feedback';
import { SUGGESTION_PAYLOADS, type SuggestionEffect } from '@forge/contracts/suggestions';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirementCriteria, requirementRevisions } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { rowIn as feedbackRowIn } from '../feedback/read.js';
import { type TriageWritten, triageIn } from '../feedback/triage.js';
import { insertIssueRow } from '../issues/create-service.js';
import { putCriteria } from '../issues/criteria/store.js';
import { activeIssuePrefix, heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { isUuid } from '../issues/issue-route-ref.js';
import { type PendingIssueRelation, writeIssueRelations } from '../issues/relations-service.js';
import { formatIssueRef, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { requirementKey, rowIn } from '../requirements/read.js';
import { linkIssueRefusal } from '../requirements/rules.js';
import {
  createRequirementIn,
  newDraftRevisionIn,
  openRevisionOf,
  type RevisionWrite,
} from '../requirements/service.js';
import { type Row, type SuggestionActor, targetOfRow } from './read.js';
import { blockerRefusal, breakdownFaults } from './rules.js';

export type Effect = SuggestionEffect | FeedbackTriageEffect;
export type AcceptChannel = 'web' | 'mcp';

export interface EffectWritten {
  refusals: NamedRefusal[] | null;
  effect?: Effect;
  triage?: TriageWritten;
  /** Issues the accept filed, announced once the transaction committed. */
  createdIssueIds?: string[];
  /** Edges the accept landed, whose effects are flushed after the commit. */
  relations?: PendingIssueRelation[];
  /** An issue whose fields the accept moved, announced after the commit. */
  updatedIssue?: { before: typeof issues.$inferSelect; written: string[] };
}

export const undecided = (kind: string, path: string, what: string): NamedRefusal => ({
  code: 'SUGGESTION_EFFECT_UNDECIDED',
  path,
  detail: `the approved designs name no effect for ${what}, so accepting this ${kind} suggestion would write nothing; reject it with a reason, or have its producer propose it without that part.`,
});

// cm:why a revision an accepted suggestion carries was written by its producer, not by the person
// who accepted it; the accept is recorded on the suggestion row (decided_by)
const authorOf = (row: Row, actor: SuggestionActor): SuggestionActor =>
  row.producerId ? { userId: row.producerId, agency: actor.agency } : actor;

/** The BC wordings live at `revision`, by code. */
async function liveCodes(tx: Tx, requirementId: string, revision: number) {
  const rows = await tx
    .select({ id: requirementCriteria.id, code: requirementCriteria.code })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        sql`${requirementCriteria.sinceRevision} <= ${revision}`,
        sql`(${requirementCriteria.retiredRevision} IS NULL OR ${requirementCriteria.retiredRevision} > ${revision})`,
      ),
    );
  return new Map(rows.map((r) => [r.code, r.id]));
}

type Breakdown = ReturnType<(typeof SUGGESTION_PAYLOADS)['breakdown']['schema']['parse']>;

/** What a breakdown is checked against, at propose and again at accept: the requirement is agreed,
 *  and the payload's traces and blockers hold at `head`. */
/** Each blockedBy entry that names an existing issue, read in the caller's transaction. */
async function namedBlockersIn(tx: Tx, projectId: string, p: Breakdown) {
  const refusals: NamedRefusal[] = [];
  const ids = new Map<string, string>();
  const prefix = await activeIssuePrefix(projectId);
  let held: string[] = [];
  const cols = {
    id: issues.id,
    projectId: issues.projectId,
    issSeq: issues.issSeq,
    status: issues.status,
    archivedAt: issues.archivedAt,
  };
  for (const [i, item] of p.issues.entries()) {
    for (const [j, ref] of (item.blockedBy ?? []).entries()) {
      if (typeof ref !== 'string') continue;
      let unreadable: string | null = null;
      let rows: {
        id: string;
        projectId: string;
        issSeq: number;
        status: string;
        archivedAt: Date | null;
      }[] = [];
      if (isUuid(ref)) {
        rows = await tx.select(cols).from(issues).where(eq(issues.id, ref));
      } else {
        if (issueRefNeedsHeldPrefixes(ref) && !held.length)
          held = await heldIssuePrefixes(projectId);
        const parsed = parseIssueRef(ref, held);
        if (parsed.ok) {
          rows = await tx
            .select(cols)
            .from(issues)
            .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq)));
        } else unreadable = parsed.message;
      }
      const row = rows[0];
      const found = row
        ? {
            key: formatIssueRef(prefix, row.issSeq),
            projectId: row.projectId,
            status: row.status,
            archived: row.archivedAt !== null,
          }
        : null;
      const path = `/payload/issues/${i}/blockedBy/${j}`;
      const refusal = blockerRefusal(path, ref, projectId, found, unreadable);
      if (refusal) refusals.push(refusal);
      else if (row) ids.set(ref, row.id);
    }
  }
  return { refusals, ids };
}

export async function breakdownGuardIn(
  tx: Tx,
  projectId: string,
  requirementId: string,
  head: number | null,
  p: Breakdown,
): Promise<{
  refusals: NamedRefusal[];
  codes: ReadonlyMap<string, string>;
  blockers: ReadonlyMap<string, string>;
}> {
  const req = await rowIn(tx, projectId, requirementId);
  const notAgreed = linkIssueRefusal(req.status as Parameters<typeof linkIssueRefusal>[0]);
  if (notAgreed || head === null) {
    return {
      refusals: [
        {
          code: notAgreed?.code ?? 'REQUIREMENT_NOT_AGREED',
          path: '/target',
          detail: `${requirementKey(req.reqSeq)} is ${req.status}; a breakdown files issues against an agreed requirement.`,
        },
      ],
      codes: new Map(),
      blockers: new Map(),
    };
  }
  const codes = await liveCodes(tx, req.id, head);
  const named = await namedBlockersIn(tx, projectId, p);
  return {
    refusals: [...breakdownFaults(p, codes, head), ...named.refusals],
    codes,
    blockers: named.ids,
  };
}

// cm:why workflow requirement-to-delivery step `approve`: core creates every issue with
// requirement_id, planned_revision, issue_criteria and blocks edges in one transaction; they are
// filed at draft, so nothing dispatches before a person promotes them
async function breakdownEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  head: number | null,
  actor: SuggestionActor,
  channel: AcceptChannel,
): Promise<EffectWritten> {
  const target = targetOfRow(row);
  const p = SUGGESTION_PAYLOADS.breakdown.schema.parse(row.payload);
  const guard = await breakdownGuardIn(tx, projectId, target.id, head, p);
  if (guard.refusals.length || head === null) return { refusals: guard.refusals };
  const { codes, blockers } = guard;
  const req = await rowIn(tx, projectId, target.id);
  const ids: string[] = [];
  for (const item of p.issues) {
    const issue = await insertIssueRow(tx, {
      projectId,
      title: item.title,
      description: item.description ?? null,
      descriptionFormat: 'markdown',
      status: 'draft',
      createdById: actor.userId,
      createdByDeviceId: null,
      createdVia: channel,
      requirementId: req.id,
      plannedRevision: head,
      fromSuggestionId: row.id,
    });
    ids.push(issue.id);
    const criteria = (item.criteria ?? []).map((c, j) => ({
      n: j + 1,
      statement: c.body,
      requirementCriterionId: c.tracesTo ? (codes.get(c.tracesTo) ?? null) : null,
    }));
    if (criteria.length) await putCriteria(tx, issue.id, criteria);
  }
  const writer = {
    actor: { type: 'user' as const, id: actor.userId, agency: actor.agency },
    createdById: actor.userId,
  };
  const relations: PendingIssueRelation[] = [];
  for (const [i, item] of p.issues.entries()) {
    const edges = (item.blockedBy ?? []).map((k) => ({
      kind: 'blocks' as const,
      dependsOnId: (typeof k === 'number' ? ids[k] : blockers.get(k)) as string,
      reason: `breakdown of ${requirementKey(req.reqSeq)} (suggestion ${row.id})`,
    }));
    relations.push(...(await writeIssueRelations(writer, projectId, ids[i] as string, edges, tx)));
  }
  const prefix = await activeIssuePrefix(projectId);
  const seqs = await tx
    .select({ id: issues.id, seq: issues.issSeq })
    .from(issues)
    .where(
      sql`${issues.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const seqOf = new Map(seqs.map((s) => [s.id, s.seq]));
  return {
    refusals: null,
    createdIssueIds: ids,
    relations,
    effect: {
      requirementId: req.id,
      requirement: requirementKey(req.reqSeq),
      revision: head,
      issues: ids.map((issueId) => ({
        issueId,
        key: formatIssueRef(prefix, seqOf.get(issueId) ?? 0),
      })),
    },
  };
}

// cm:why workflow requirement-to-delivery step `ready`: readiness is a suggestion kind with no table
// of its own, so the accepted row at its base revision IS the readiness result an agree reads
async function readinessEffect(tx: Tx, projectId: string, row: Row): Promise<EffectWritten> {
  const req = await rowIn(tx, projectId, targetOfRow(row).id);
  const { checks } = SUGGESTION_PAYLOADS.readiness.schema.parse(row.payload);
  const failed = checks.filter((c) => !c.passed).map((c) => c.check);
  return {
    refusals: null,
    effect: {
      requirementId: req.id,
      requirement: requirementKey(req.reqSeq),
      revision: row.baseRevision,
      ready: failed.length === 0,
      failed,
    },
  };
}

async function issueRowOf(tx: Tx, projectId: string, issueId: string) {
  const [issue] = await tx
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .for('update');
  if (!issue) throw new Error(`suggestions: issue ${issueId} vanished under its suggestion`);
  return issue;
}

// cm:why a triage suggestion on an issue carries priority and category, which an accept sets; its
// free-text `route` names nothing the issue lifecycle defines, so it is refused, never dropped
async function issueTriageEffect(tx: Tx, projectId: string, row: Row): Promise<EffectWritten> {
  const p = SUGGESTION_PAYLOADS.triage.schema.parse(row.payload);
  if (p.route !== undefined) {
    return { refusals: [undecided('triage', '/payload/route', 'a triage route on an issue')] };
  }
  const before = await issueRowOf(tx, projectId, targetOfRow(row).id);
  const set: Partial<typeof issues.$inferInsert> = {};
  if (p.priority) set.priority = p.priority;
  if (p.category !== undefined) set.category = p.category;
  if (Object.keys(set).length) {
    await tx
      .update(issues)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(issues.id, before.id));
  }
  return {
    refusals: null,
    updatedIssue: { before, written: Object.keys(set) },
    effect: {
      issueId: before.id,
      issue: formatIssueRef(await activeIssuePrefix(projectId), before.issSeq),
      priority: p.priority ?? null,
      category: p.category ?? null,
    },
  };
}

export async function writeEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  head: number | null,
  actor: SuggestionActor,
  channel: AcceptChannel,
): Promise<EffectWritten> {
  const target = targetOfRow(row);
  if (row.kind === 'feedback_triage' && target.type === 'feedback') {
    const written = await triageIn(tx, {
      projectId,
      row: await feedbackRowIn(tx, projectId, target.id, true),
      triage: SUGGESTION_PAYLOADS.feedback_triage.schema.parse(row.payload),
      actor,
      channel,
      fromSuggestionId: row.id,
    });
    if (written.refusals?.length) return { refusals: written.refusals };
    return {
      refusals: null,
      ...(written.effect ? { effect: written.effect } : {}),
      triage: written,
    };
  }
  if (row.kind === 'revision_diff' && target.type === 'requirement') {
    const write = SUGGESTION_PAYLOADS.revision_diff.schema.parse(row.payload) as RevisionWrite;
    const refusals = await newDraftRevisionIn(tx, {
      requirementId: target.id,
      head,
      open: await openRevisionOf(tx, target.id),
      baseRevision: row.baseRevision,
      actor: authorOf(row, actor),
      write: { ...write, fromSuggestionId: row.id },
    });
    if (refusals?.length) return { refusals };
    const [written] = await tx
      .select({ revision: requirementRevisions.revision })
      .from(requirementRevisions)
      .where(eq(requirementRevisions.fromSuggestionId, row.id));
    const req = await rowIn(tx, projectId, target.id);
    await tx
      .update(suggestions)
      .set({
        status: 'stale',
        decidedAt: new Date(),
        reason: `suggestion ${row.id} was accepted as a new draft revision of this requirement`,
      })
      .where(
        and(
          eq(suggestions.requirementId, target.id),
          eq(suggestions.status, 'proposed'),
          sql`${suggestions.id} <> ${row.id}`,
        ),
      );
    return {
      refusals: null,
      effect: {
        requirementId: target.id,
        requirement: requirementKey(req.reqSeq),
        revision: written?.revision ?? 0,
      },
    };
  }
  if (row.kind === 'requirement_draft') {
    const { title, ...write } = SUGGESTION_PAYLOADS.requirement_draft.schema.parse(row.payload);
    const created = await createRequirementIn(tx, {
      projectId,
      actor,
      authorId: authorOf(row, actor).userId,
      title,
      write: { ...(write as RevisionWrite), fromSuggestionId: row.id },
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const req = await rowIn(tx, projectId, created.id);
    return {
      refusals: null,
      effect: { requirementId: created.id, requirement: requirementKey(req.reqSeq), revision: 1 },
    };
  }
  if (row.kind === 'breakdown' && target.type === 'requirement') {
    return breakdownEffect(tx, projectId, row, head, actor, channel);
  }
  if (row.kind === 'readiness' && target.type === 'requirement') {
    return readinessEffect(tx, projectId, row);
  }
  if (row.kind === 'triage' && target.type === 'issue') {
    return issueTriageEffect(tx, projectId, row);
  }
  if (row.kind === 'duplicate' && target.type === 'requirement') {
    return {
      refusals: [undecided('duplicate', '/target', 'marking a requirement a duplicate of another')],
    };
  }
  throw new Error(`suggestions: no effect writer for a ${row.kind} suggestion on ${target.type}`);
}

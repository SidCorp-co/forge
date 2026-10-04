/**
 * What accepting a suggestion writes, kind by kind, inside the accept's transaction (workflow
 * `suggestion-lifecycle` rev 2: "its effect — a revision, issues, a triage — was written in the same
 * transaction and points back at it"). Each writer returns refusals that roll the accept back, or
 * the effect the caller reads back. A kind whose effect the approved designs leave undecided is
 * refused SUGGESTION_EFFECT_UNDECIDED rather than accepted with nothing written.
 */

import type { FeedbackTriageEffect } from '@forge/contracts/feedback';
import { SUGGESTION_MACHINE } from '@forge/contracts/suggestion-machine';
import { SUGGESTION_PAYLOADS, type SuggestionEffect } from '@forge/contracts/suggestions';
import { and, eq, sql } from 'drizzle-orm';
import { insertComment, type WrittenComment } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { rowIn as feedbackRowIn } from '../feedback/read.js';
import { type TriageWritten, triageIn } from '../feedback/triage.js';
import { setIssueTriage } from '../issues/index.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import type { PendingIssueRelation } from '../issues/relations-service.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { transition } from '../lifecycle/transition.js';
import { requirementKey, rowIn } from '../requirements/read.js';
import {
  createRequirementIn,
  newDraftRevisionIn,
  openRevisionOf,
  type RevisionWrite,
} from '../requirements/service.js';
import { breakdownEffect } from './breakdown.js';
import { type Row, type SuggestionActor, suggestionKernelActor, targetOfRow } from './read.js';

export type Effect = SuggestionEffect | FeedbackTriageEffect;
export type AcceptChannel = 'web' | 'mcp';

export interface EffectWritten {
  refusals: Refusal[] | null;
  effect?: Effect;
  triage?: TriageWritten;
  /** Issues the accept filed, announced once the transaction committed. */
  createdIssueIds?: string[];
  /** Edges the accept landed, whose effects are flushed after the commit. */
  relations?: PendingIssueRelation[];
  /** An issue whose fields the accept moved, announced after the commit. */
  updatedIssue?: { before: typeof issues.$inferSelect; written: string[] };
  routeComment?: { issueId: string; row: WrittenComment['row']; authored: 'human' | 'agent' };
}

export const undecided = (kind: string, path: string, what: string): Refusal => ({
  code: 'SUGGESTION_EFFECT_UNDECIDED',
  path,
  detail: `the approved designs name no effect for ${what}, so accepting this ${kind} suggestion would write nothing; reject it with a reason, or have its producer propose it without that part.`,
});

// cm:why a revision an accepted suggestion carries was written by its producer, not by the person
// who accepted it; the accept is recorded on the suggestion row (decided_by)
const authorOf = (row: Row, actor: SuggestionActor): SuggestionActor =>
  row.producerId ? { userId: row.producerId, agency: actor.agency } : actor;

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

type IssueTriage = ReturnType<(typeof SUGGESTION_PAYLOADS)['triage']['schema']['parse']>;

// cm:why decision on ISS-58 (2026-10-04): a triage suggestion on an issue applies only the fields the
// feedback-triage design names, priority, category and complexity; its free-text `route` is not an
// effect, so it is kept as a note comment on the issue rather than refused or dropped
export function issueTriageOf(p: IssueTriage, suggestionId: string) {
  const set: Partial<Pick<typeof issues.$inferInsert, 'priority' | 'category' | 'complexity'>> = {};
  if (p.priority) set.priority = p.priority;
  if (p.category !== undefined) set.category = p.category;
  if (p.complexity) set.complexity = p.complexity;
  const routeNote =
    p.route === undefined
      ? null
      : `Triage route (suggestion ${suggestionId}): ${p.route}\n\n${p.note}`;
  return { set, routeNote };
}

async function issueTriageEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  actor: SuggestionActor,
): Promise<EffectWritten> {
  const { set, routeNote } = issueTriageOf(
    SUGGESTION_PAYLOADS.triage.schema.parse(row.payload),
    row.id,
  );
  const before = await issueRowOf(tx, projectId, targetOfRow(row).id);
  await setIssueTriage(tx, before.id, set);
  const note = routeNote
    ? await insertComment(
        {
          issueId: before.id,
          authorId: authorOf(row, actor).userId,
          authorDeviceId: null,
          body: routeNote,
          format: 'markdown',
          parentId: null,
          intent: 'note',
        },
        tx,
      )
    : null;
  return {
    refusals: null,
    updatedIssue: { before, written: Object.keys(set) },
    ...(note
      ? {
          routeComment: {
            issueId: before.id,
            row: note.row,
            authored: row.producerKind === 'person' ? ('human' as const) : ('agent' as const),
          },
        }
      : {}),
    effect: {
      issueId: before.id,
      issue: formatIssueRef(await activeIssuePrefix(projectId), before.issSeq),
      priority: set.priority ?? null,
      category: set.category ?? null,
      complexity: set.complexity ?? null,
      routeCommentId: note?.row.id ?? null,
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
    const { dedup: _dedup, ...triage } = SUGGESTION_PAYLOADS.feedback_triage.schema.parse(
      row.payload,
    );
    const written = await triageIn(tx, {
      projectId,
      row: await feedbackRowIn(tx, projectId, target.id, true),
      triage,
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
    const supersededBy = `suggestion ${row.id} was accepted as a new draft revision of this requirement`;
    await transition(tx, SUGGESTION_MACHINE, {
      to: 'stale',
      from: 'proposed',
      set: { decidedAt: new Date(), reason: supersededBy },
      where: and(eq(suggestions.requirementId, target.id), sql`${suggestions.id} <> ${row.id}`),
      reason: supersededBy,
      actor: suggestionKernelActor(actor),
      source: 'suggestions-effect',
      returning: ['id'],
    });
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
    return issueTriageEffect(tx, projectId, row, actor);
  }
  // an accepted design_change writes nothing into the design: the acceptance is the record that the
  // design owes a revision touching those nodes (REQ-17 BC-12)
  if (row.kind === 'design_change' && target.type === 'workflow') return { refusals: null };
  if (row.kind === 'duplicate' && target.type === 'requirement') {
    return {
      refusals: [undecided('duplicate', '/target', 'marking a requirement a duplicate of another')],
    };
  }
  throw new Error(`suggestions: no effect writer for a ${row.kind} suggestion on ${target.type}`);
}

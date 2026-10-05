import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { and, eq } from 'drizzle-orm';
import { insertComment } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { activeIssuePrefix, emitIssueFieldUpdate, setIssueTriage } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { emitEvent } from '../outbox/index.js';
import type { EffectWritten } from './effects.js';
import { type Row, type SuggestionActor, targetOfRow } from './read.js';

// A revision an accepted suggestion carries was written by its producer, not by the person
// who accepted it; the accept is recorded on the suggestion row (decided_by)
export const authorOf = (row: Row, actor: SuggestionActor): SuggestionActor =>
  row.producerId ? { userId: row.producerId, agency: actor.agency } : actor;

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

// Decision on ISS-58 (2026-10-04): a triage suggestion on an issue applies only the fields the
// feedback-triage design names, priority, category and complexity; its free-text `route` is not an
// effect, so it is kept as a note comment on the issue rather than refused or dropped
function issueTriageOf(p: IssueTriage, suggestionId: string) {
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

export async function issueTriageEffect(
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
  const who = { type: 'user' as const, id: actor.userId, agency: actor.agency };
  const after = await issueRowOf(tx, projectId, before.id);
  await emitIssueFieldUpdate(tx, { before, after, written: Object.keys(set), actor: who });
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
  if (note) {
    await emitEvent(tx, 'comment.created', {
      issueId: before.id,
      projectId,
      actor: who,
      authored: row.producerKind === 'person' ? 'human' : 'agent',
      commentId: note.row.id,
      body: note.row.body,
      parentId: null,
    });
  }
  return {
    refusals: null,
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

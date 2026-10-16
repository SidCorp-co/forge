import type { IssueStatus, WaitingKind } from '../../db/issue-vocabulary.js';
import {
  type ApplyStatusTransitionOptions,
  transitionIssueStatus,
} from '../../issues/apply-transition.js';
import {
  type AppliedIssueRelation,
  type applyIssueRelations,
  flushIssueRelationEffects,
  type IssueRelationInput,
  type PendingIssueRelation,
  writeBesideRelations,
  writeIssueRelations,
} from '../../issues/relations-service.js';
import { TransitionError } from '../../issues/transition-error.js';
import {
  announceContractInput,
  type IssueUpdateInput,
  writeIssueFieldsIn,
} from '../../issues/update-service.js';
import { unwrittenRefusal } from './forge-issues-update-refusal.js';
import { principalActor } from './lib.js';

/** The part of `forge_issues` `data` a status move reads. */
export interface TransitionData {
  reason?: string | undefined;
  note?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  needs?: string | undefined;
  voidQuestions?: string | undefined;
}

type InTransaction = Pick<
  ApplyStatusTransitionOptions,
  'beforeStatusWrite' | 'releaseNotesWritten'
>;

/**
 * One status move off `data`, the same for `update` and `transition`. Its answer carries
 * `rewritten`, which both actions hand back so a caller reads what a rule stored (ISS-1365).
 */
export function transitionByData(
  issue: Parameters<typeof transitionIssueStatus>[0],
  status: IssueStatus,
  principal: Parameters<typeof principalActor>[0],
  data: TransitionData | undefined,
  inTransaction: InTransaction = {},
) {
  return transitionIssueStatus(issue, status, principalActor(principal), {
    transitionReason: data?.reason?.trim() || data?.note?.trim() || undefined,
    waitingKind: data?.waitingKind,
    needs: data?.needs,
    voidQuestions: data?.voidQuestions,
    ...inTransaction,
  });
}

/** What an `update` writes beside its status move. */
export interface UpdateWrites {
  /** The field and label write, or null where the update carries neither. */
  fields: IssueUpdateInput | null;
  relations: readonly IssueRelationInput[] | undefined;
  writer: Parameters<typeof applyIssueRelations>[0];
}

/**
 * An `update` that moves a status writes its fields, labels and relations inside the move's own
 * transaction, before the status write, so the move reads them (a `plan` beside `approved`, release
 * notes beside `closed`) and a refused move leaves none of them written (ISS-1229 r10). A refusal
 * raised before the commit says so first; a status alone is refused in the transition door's words.
 */
export async function moveWithWrites(
  issue: Parameters<typeof transitionIssueStatus>[0],
  status: IssueStatus,
  principal: Parameters<typeof principalActor>[0],
  data: TransitionData | undefined,
  writes: UpdateWrites,
): Promise<{
  rewritten: Awaited<ReturnType<typeof transitionIssueStatus>>['rewritten'];
  relations: AppliedIssueRelation[];
}> {
  const { fields, relations, writer } = writes;
  const carries = fields !== null || (relations?.length ?? 0) > 0;
  let wrote = false;
  let pending: PendingIssueRelation[] = [];
  // A refusal the writes raised is known to be inside the transaction; anything else thrown after
  // the move began may come after its commit, and is let through as it is.
  let refusedInWrites: unknown = null;
  const inTransaction: InTransaction = carries
    ? {
        beforeStatusWrite: async (tx) => {
          try {
            if (fields) ({ wrote } = await writeIssueFieldsIn(tx, fields));
            pending = await writeIssueRelations(writer, issue.projectId, issue.id, relations, tx);
          } catch (err) {
            refusedInWrites = err;
            throw err;
          }
        },
        ...(fields && 'releaseNotes' in fields.updates
          ? { releaseNotesWritten: fields.updates.releaseNotes }
          : {}),
      }
    : {};
  let moved: Awaited<ReturnType<typeof transitionIssueStatus>>;
  try {
    moved = await transitionByData(issue, status, principal, data, inTransaction);
  } catch (err) {
    if (carries && (err instanceof TransitionError || err === refusedInWrites)) {
      throw unwrittenRefusal(err, true);
    }
    throw err;
  }
  if (wrote && fields) await announceContractInput(issue.id, issue.projectId, fields.updates);
  await flushIssueRelationEffects(writer, issue.projectId, pending);
  return { rewritten: moved.rewritten, relations: pending.map((p) => p.applied) };
}

/**
 * An `update` that sends no status writes its fields, labels and relations in one transaction, so a
 * relation the graph refuses leaves the title beside it unwritten too, and the refusal says so.
 */
export async function writeWithoutMove(
  issue: Parameters<typeof transitionIssueStatus>[0],
  writes: UpdateWrites,
): Promise<AppliedIssueRelation[]> {
  const { fields, relations, writer } = writes;
  if (fields === null && (relations?.length ?? 0) === 0) return [];
  let wrote = false;
  let pending: PendingIssueRelation[];
  try {
    ({ wrote, pending } = await writeBesideRelations(
      writer,
      issue.projectId,
      issue.id,
      relations,
      async (tx) => (fields ? (await writeIssueFieldsIn(tx, fields)).wrote : false),
    ));
  } catch (err) {
    throw unwrittenRefusal(err, false);
  }
  if (wrote && fields) await announceContractInput(issue.id, issue.projectId, fields.updates);
  await flushIssueRelationEffects(writer, issue.projectId, pending);
  return pending.map((p) => p.applied);
}

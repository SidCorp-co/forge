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
  writeIssueRelations,
} from '../../issues/relations-service.js';
import { TransitionError } from '../../issues/transition-error.js';
import {
  announceContractInput,
  type IssueUpdateInput,
  writeIssueFieldsIn,
} from '../../issues/update-service.js';
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

const NOTHING_WRITTEN =
  'Nothing else this update carried was written: send it again without `data.status` to write the rest';

/**
 * An `update` that moves a status writes its fields, labels and relations inside the move's own
 * transaction, before the status write, so the move reads them (a `plan` beside `approved`, release
 * notes beside `closed`) and a refused move leaves none of them written (ISS-1229 r10). The refusal
 * says so; a status alone is refused in the transition door's own words.
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
  const inTransaction: InTransaction = carries
    ? {
        beforeStatusWrite: async (tx) => {
          if (fields) ({ wrote } = await writeIssueFieldsIn(tx, fields));
          pending = await writeIssueRelations(writer, issue.projectId, issue.id, relations, tx);
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
    if (carries && err instanceof TransitionError) {
      throw new TransitionError(
        err.code,
        `${err.detail.replace(/\.$/, '')}. ${NOTHING_WRITTEN}`,
        err.details,
      );
    }
    throw err;
  }
  if (wrote && fields) await announceContractInput(issue.id, issue.projectId, fields.updates);
  await flushIssueRelationEffects(writer, issue.projectId, pending);
  return { rewritten: moved.rewritten, relations: pending.map((p) => p.applied) };
}

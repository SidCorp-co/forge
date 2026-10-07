import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues, type LandingShape, projects } from '../db/schema.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { CONTRACT_INPUT_FIELDS } from './entry-criteria-keys.js';
import type { ResolvedLabelAttach } from './label-service.js';
import { landingShapeMarkStandsDetail, laneOrNull } from './landing-evidence.js';
import { type MergeMarkKind, mergeMarkKindOf } from './merge-record.js';
import type { IssueRow } from './read-service.js';
import type { SessionContextExpect } from './session-context.js';

export type IssueUpdateInput = {
  issueId: string;
  /** Plain column writes, already filtered through `collectIssueFieldUpdates`. */
  updates: Record<string, unknown>;
  /**
   * Replace-set. `undefined` leaves labels untouched; `[]` clears them. Resolved rows only —
   * run them through `label-service` BEFORE calling, so an unknown label or an illegal
   * primary fails outside the transaction rather than rolling one back.
   */
  labelIds?: ResolvedLabelAttach[] | undefined;
  /**
   * ISS-959 — the `sessionContext` the caller read, sent back as the write's
   * precondition. `undefined` writes unconditionally, exactly as before.
   */
  expect?: SessionContextExpect | undefined;
  actor: Actor;
};

export async function updateIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const { row, wrote } = await writeIssueFields(input);
  if (wrote) await announceContractInput(input.issueId, row.projectId, input.updates);
  return row;
}

/** Column keys a write may carry that record the write itself rather than change the issue. */
const WRITE_STAMPS: ReadonlySet<string> = new Set(['updatedAt']);

/** The declaration is the only thing this write changes, so a value equal to the one stored is
 *  a no-op: it is answered with the row as it stands and nothing, `updated_at` included, moves. */
function declarationOnly(input: IssueUpdateInput): boolean {
  const keys = Object.keys(input.updates).filter((k) => !WRITE_STAMPS.has(k));
  return (
    keys.length === 1 &&
    keys[0] === 'declaredLandingShape' &&
    input.labelIds === undefined &&
    input.expect === undefined
  );
}

async function writeIssueFields(
  input: IssueUpdateInput,
): Promise<{ row: IssueRow; wrote: boolean }> {
  const { issueId, updates, labelIds, expect, actor } = input;
  const guard = expect ? [sessionContextGuard(expect.sessionContext)] : [];
  const shape = updates.declaredLandingShape as LandingShape | null | undefined;
  if (shape !== undefined) guard.push(shapeUnderNoMarkGuard(shape));
  const noOpPossible = shape !== undefined && declarationOnly(input);
  if (noOpPossible) guard.push(shapeMovesGuard(shape));

  return db.transaction(async (tx) => {
    if (updates.sessionContext !== undefined && !expect) {
      await refuseUnreadSessionContextDrop(tx, issueId, updates.sessionContext);
    }
    const [row] = await tx
      .update(issues)
      .set(updates)
      .where(and(eq(issues.id, issueId), ...guard))
      .returning();
    if (!row) {
      if (noOpPossible) {
        const [held] = await tx.select().from(issues).where(eq(issues.id, issueId)).limit(1);
        if (held && held.declaredLandingShape === shape) return { row: held, wrote: false };
      }
      if (shape !== undefined) await refuseShapeOverMark(tx, issueId, shape);
      if (expect) await refuseMovedSessionContext(tx, issueId);
      throw new IssueUpdateNotFound(issueId);
    }

    if (labelIds !== undefined) {
      const existing = await tx
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .where(eq(issueLabels.issueId, issueId));
      const oldSet = new Set(existing.map((r) => r.labelId));
      const newSet = new Set(labelIds.map((l) => l.labelId));

      await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
      if (labelIds.length > 0) {
        await tx
          .insert(issueLabels)
          .values(labelIds.map((l) => ({ issueId, labelId: l.labelId, isPrimary: l.isPrimary })));
      }

      for (const labelId of [...newSet].filter((l) => !oldSet.has(l))) {
        await recordActivityTx(tx, {
          issueId,
          actor,
          action: 'issue.labeled',
          payload: { labelId },
        });
      }
      for (const labelId of [...oldSet].filter((l) => !newSet.has(l))) {
        await recordActivityTx(tx, {
          issueId,
          actor,
          action: 'issue.unlabeled',
          payload: { labelId },
        });
      }
    }

    return { row, wrote: true };
  });
}

async function announceContractInput(
  issueId: string,
  projectId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const moved = CONTRACT_INPUT_FIELDS.filter((f) => f in updates);
  if (moved.length === 0) return;
  await hooks.emit('contractInputChanged', {
    projectId,
    issueId,
    reason: `fields written: ${moved.join(', ')}`,
  });
}

/**
 * A `sessionContext` write replaces the field whole, so one that omits a key the
 * field already holds destroys it — there is no history to read it back from.
 * A caller that sent `expect` read the current value and means the removal, so
 * it passes. One that did not is refused by name, naming the keys it would have
 * dropped, because the alternative is the write landing silently: a probe body
 * of `{ probe: 1 }` took `landing`, `lease` and `worklog` off ISS-1127 in one
 * call on 2026-09-21, and the landing checkpoint underneath was unrecoverable.
 */
async function refuseUnreadSessionContextDrop(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  issueId: string,
  next: unknown,
): Promise<void> {
  const [current] = await tx
    .select({ sessionContext: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const held = current?.sessionContext;
  if (!held || typeof held !== 'object' || Array.isArray(held)) return;

  const kept = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  const dropped = Object.keys(held).filter((k) => !(k in (kept as Record<string, unknown>)));
  if (dropped.length === 0) return;
  throw new SessionContextDropsUnreadKeys(dropped);
}

export class SessionContextDropsUnreadKeys extends Error {
  constructor(readonly dropped: string[]) {
    super('SESSION_CONTEXT_DROPS_UNREAD_KEYS');
    this.name = 'SessionContextDropsUnreadKeys';
  }
}

function sessionContextGuard(expected: Record<string, unknown> | null) {
  const expr = expected === null ? sql`null::jsonb` : sql`${JSON.stringify(expected)}::jsonb`;
  return sql`${issues.sessionContext} is not distinct from ${expr}`;
}

/**
 * Zero rows updated under a precondition means one of two things, and a caller
 * told the wrong one retries forever or gives up wrongly. Re-read inside the
 * doomed transaction: the row is gone, or the field moved — and when it moved,
 * hand back the value it moved TO, which is what the loser needs to rebase its
 * lease and try again.
 */
async function refuseMovedSessionContext(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  issueId: string,
): Promise<void> {
  const [current] = await tx
    .select({ sessionContext: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!current) return;
  throw new SessionContextExpectMismatch(current.sessionContext ?? null);
}

/** The write carried an `expect` the field no longer holds. `current` is what it holds now. */
export class SessionContextExpectMismatch extends Error {
  constructor(readonly current: unknown) {
    super('SESSION_CONTEXT_MISMATCH');
    this.name = 'SessionContextExpectMismatch';
  }
}

/**
 * A mark is judged on the lane it was made under, so the lane may change only while no mark stands
 * or to the value it already holds. The condition is the UPDATE's own WHERE, so no mark can land
 * between the decision and the write.
 */
function shapeUnderNoMarkGuard(next: LandingShape | null) {
  return sql`(${issues.mergedAt} IS NULL OR ${issues.declaredLandingShape} IS NOT DISTINCT FROM ${next}::text)`;
}

/** The declaration-only write lands only where it changes the declaration. */
function shapeMovesGuard(next: LandingShape | null) {
  return sql`${issues.declaredLandingShape} IS DISTINCT FROM ${next}::text`;
}

/** Zero rows under the lane guard: re-read, and where a mark stands, say so with what it holds. */
async function refuseShapeOverMark(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  issueId: string,
  sent: LandingShape | null,
): Promise<void> {
  const [current] = await tx
    .select({
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
      mergedLanding: issues.mergedLanding,
      declared: issues.declaredLandingShape,
      kind: projects.kind,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!current || current.mergedAt === null || current.declared === sent) return;
  throw new LandingShapeMarkStands({
    held: current.declared,
    sent,
    project: laneOrNull(null, current.kind)?.shape ?? null,
    mark: mergeMarkKindOf(current),
  });
}

/** `landingShape` was sent while a merged mark stands on the issue; nothing was written. */
export class LandingShapeMarkStands extends Error {
  readonly code = 'LANDING_SHAPE_MARK_STANDS';
  readonly held: LandingShape | null;
  readonly sent: LandingShape | null;
  readonly mark: MergeMarkKind;
  constructor(args: Parameters<typeof landingShapeMarkStandsDetail>[0]) {
    super(landingShapeMarkStandsDetail(args));
    this.name = 'LandingShapeMarkStands';
    this.held = args.held;
    this.sent = args.sent;
    this.mark = args.mark;
  }
}

export class IssueUpdateNotFound extends Error {
  constructor(readonly issueId: string) {
    super('ISSUE_NOT_FOUND');
    this.name = 'IssueUpdateNotFound';
  }
}

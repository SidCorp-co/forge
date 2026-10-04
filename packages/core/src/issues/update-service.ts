import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import { leaseWriteTakes } from '../pipeline/session-claim.js';
import { plannedRevisionFor } from '../requirements/issue-links.js';
import { refuseHeldTake } from './blocked-by.js';
import { syncCriteriaFromText } from './criteria/store.js';
import type { ResolvedLabelAttach } from './label-service.js';
import { ISSUE_READ_COLUMNS, type IssueRow } from './read-service.js';
import type { SessionContextExpect } from './session-context.js';
import {
  splitSessionContext,
  type WorkStateWrite,
  writeSplitSessionContext,
  writeWorkStateFields,
} from './work-state.js';

const refuse = refuser<IssueUpdateRefusalCode>('ISSUE_UPDATE_REFUSED');

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
  /** ISS-54 — the step, branch and head of the work, written to `issue_work_state`. */
  workState?: WorkStateWrite | undefined;
  actor: Actor;
  /** The fields the write moves, before and after; non-empty, they are its `issue.updated` event. */
  changes?: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
};

export async function updateIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const row = await writeIssueFields(input);
  return row;
}

type UpdateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One write of an issue's fields. The row is locked first, so the `sessionContext` the
 * precondition and the unread-drop rule compare against is the value this write replaces.
 *
 * ISS-54 cm:hack — that value is the COMPOSED one (`issue_session_context`): the blob with the
 * lease `issue_work_state` holds put back, because that is what every reader was handed and so
 * what a caller sends back as `expect`. A whole `sessionContext` write is split the same way: the
 * lease and the worklog's branch and head go to the work state, the rest to the column. Exit: until
 * forge-plugin moves to the 10-status model (plugin-followups.md).
 */
async function writeIssueFields(input: IssueUpdateInput): Promise<IssueRow> {
  const { issueId, updates, labelIds, expect, workState, actor, changes } = input;

  return db.transaction(async (tx) => {
    const current = await lockComposedSessionContext(tx, issueId);
    if (!current) throw notFound('issue not found');
    if (expect && !sameJson(current.sessionContext, expect.sessionContext)) {
      throw refuse(
        'SESSION_CONTEXT_MISMATCH',
        '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
          'Re-read the issue, decide whether your claim still stands, and send the write again with the new `expect`.',
        '/expect/sessionContext',
      );
    }

    const columns = { ...updates };
    if (updates.plan !== undefined) {
      const planned = await plannedRevisionFor(tx, issueId, updates.plan as string | null);
      if (planned) Object.assign(columns, planned);
    }
    if (updates.sessionContext !== undefined) {
      if (!expect) refuseUnreadSessionContextDrop(current.sessionContext, updates.sessionContext);
      const split = splitSessionContext(updates.sessionContext);
      if (
        split.lease.present &&
        leaseWriteTakes(leaseIn(current.sessionContext), split.lease.value, new Date())
      ) {
        await refuseHeldTake(tx, issueId, 'a write that takes the lease');
      }
      columns.sessionContext = split.rest;
      await writeSplitSessionContext(tx, issueId, split);
    }
    if (workState) await writeWorkStateFields(tx, issueId, workState);

    const [row] = await tx
      .update(issues)
      .set(columns)
      .where(eq(issues.id, issueId))
      .returning({ id: issues.id });
    if (!row) throw notFound('issue not found');
    if (updates.acceptanceCriteria !== undefined) {
      await syncCriteriaFromText(
        tx,
        issueId,
        (updates.acceptanceCriteria as string | null) ?? null,
      );
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

    const [written] = await tx
      .select(ISSUE_READ_COLUMNS)
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!written) throw notFound('issue not found');
    if (changes && changes.fields.length > 0) {
      await emitEvent(tx, 'issue.updated', {
        issueId,
        projectId: written.projectId,
        actor,
        ...changes,
      });
    }
    return written;
  });
}

async function lockComposedSessionContext(
  tx: UpdateTx,
  issueId: string,
): Promise<{ sessionContext: unknown } | null> {
  const rows = (await tx.execute(sql`
    SELECT issue_session_context(i.id, i.session_context) AS session_context
      FROM issues i WHERE i.id = ${issueId} FOR UPDATE
  `)) as unknown as Array<{ session_context: unknown }>;
  const row = rows[0];
  return row ? { sessionContext: row.session_context ?? null } : null;
}

function leaseIn(context: unknown): unknown {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return (context as Record<string, unknown>).lease ?? null;
}

/** JSON equality as `jsonb` compares it: key order is not part of the value. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * A `sessionContext` write replaces the field whole, so one that omits a key the
 * field already holds destroys it — there is no history to read it back from.
 * A caller that sent `expect` read the current value and means the removal, so
 * it passes. One that did not is refused by name, naming the keys it would drop.
 */
function refuseUnreadSessionContextDrop(held: unknown, next: unknown): void {
  if (!held || typeof held !== 'object' || Array.isArray(held)) return;
  const kept = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  const dropped = Object.keys(held).filter((k) => !(k in (kept as Record<string, unknown>)));
  if (dropped.length === 0) return;
  throw refuse(
    'SESSION_CONTEXT_DROPS_UNREAD_KEYS',
    `this write replaces \`sessionContext\` whole and would remove ${dropped.join(', ')}, ` +
      'which it never read. Read the field, add your key to what is there, and send it back complete — ' +
      'or send `expect: { sessionContext: <what you read> }` to say the removal is deliberate.',
    '/sessionContext',
  );
}

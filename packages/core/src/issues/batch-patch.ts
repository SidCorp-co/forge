// `PATCH /api/issues/batch`: one status move and the triage fields on up to a hundred issues, each
// issue answered on its own as updated, skipped or failed.

import type { ActorAgency } from '@forge/contracts/permissions';
import { HTTPException } from 'hono/http-exception';
import type { IssuePriority, IssueStatus } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { holds } from '../permissions/index.js';
import { TransitionError, transitionIssueStatus } from './apply-transition.js';
import { BATCH_SKIP_BY_CODE, type BatchSkipReason } from './batch-skip-reason.js';
import { applyBatchFieldEdit, type IssueTriage } from './field-writes.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { batchIssueRows } from './read-service.js';
import { publishUnblockCascade } from './transition.js';

type BatchResult = {
  updated: Array<{
    id: string;
    displayId: string;
    skipReason?: BatchSkipReason;
  }>;
  skipped: Array<{ id: string; reason: BatchSkipReason }>;
  failed: Array<{ id: string; error: string }>;
};

type BatchData = {
  status?: IssueStatus | undefined;
  priority?: IssuePriority | undefined;
  category?: string | null | undefined;
};

type BatchRow = Awaited<ReturnType<typeof batchIssueRows>>[number];
type TerminalMove = Parameters<typeof publishUnblockCascade>[0][number];
/** The account acting: a REST batch is always a user's. */
type BatchActor = { type: 'user'; id: string; agency: ActorAgency };

type ProjectAccessState = { allowed: boolean; missing?: boolean };

async function accessByProject(
  projectIds: readonly string[],
  userId: string,
): Promise<Map<string, ProjectAccessState>> {
  return new Map(
    await Promise.all(
      projectIds.map(async (projectId): Promise<[string, ProjectAccessState]> => {
        try {
          const access = await loadProjectAccess(projectId, userId);
          return [projectId, { allowed: holds(access, 'project.write') }];
        } catch (err) {
          if (err instanceof HTTPException && err.status === 404) {
            return [projectId, { allowed: false, missing: true }];
          }
          throw err;
        }
      }),
    ),
  );
}

/**
 * The status move, if asked. A refused move is not thrown: the single-issue `/transition` refuses
 * it in the envelope, the batch answers it as the row's skip reason so a caller sees it even
 * when the triage fields on the same row went through.
 */
async function moveStatus(
  row: BatchRow,
  toStatus: IssueStatus,
  actor: BatchActor,
  terminal: TerminalMove[],
): Promise<BatchSkipReason | null> {
  try {
    const moved = await transitionIssueStatus(
      {
        id: row.id,
        projectId: row.projectId,
        status: row.status as IssueStatus,
        reopenCount: row.reopenCount,
      },
      toStatus,
      actor,
    );
    row.status = toStatus;
    row.reopenCount = moved.reopenCount;
    if (moved.terminal) {
      terminal.push({
        issueId: row.id,
        projectId: row.projectId,
        issSeq: row.issSeq,
        at: moved.updatedAt,
        ...(toStatus === 'dropped' ? { dependents: moved.unblockedDependents } : {}),
      });
    }
    return null;
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;
    return BATCH_SKIP_BY_CODE[err.code];
  }
}

/** Priority and category, written together where either changed; true where one did. */
async function editTriage(row: BatchRow, data: BatchData, actor: BatchActor): Promise<boolean> {
  const updates: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const [key, next, current] of [
    ['priority', data.priority, row.priority],
    ['category', data.category, row.category],
  ] as const) {
    if (next === undefined || next === current) continue;
    updates[key] = next;
    before[key] = current;
    fields.push(key);
  }
  if (fields.length === 0) return false;
  await applyBatchFieldEdit(row, updates as IssueTriage, { actor, fields, before, after: updates });
  return true;
}

export async function patchIssueBatch(
  ids: readonly string[],
  data: BatchData,
  userId: string,
  actor: BatchActor,
): Promise<BatchResult> {
  const result: BatchResult = { updated: [], skipped: [], failed: [] };
  const rows = await batchIssueRows([...ids]);
  const foundIds = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!foundIds.has(id)) result.skipped.push({ id, reason: 'not_found' });
  }
  const projects = [...new Set(rows.map((r) => r.projectId))];
  const access = await accessByProject(projects, userId);
  const prefixes = new Map(
    await Promise.all(projects.map(async (p) => [p, await activeIssuePrefix(p)] as const)),
  );
  const terminal: TerminalMove[] = [];

  for (const row of rows) {
    const held = access.get(row.projectId);
    if (held?.missing || !held?.allowed) {
      result.skipped.push({ id: row.id, reason: held?.missing ? 'not_found' : 'forbidden' });
      continue;
    }
    let skipReason: BatchSkipReason | null = null;
    let touched = false;
    try {
      if (data.status !== undefined) {
        skipReason = await moveStatus(row, data.status, actor, terminal);
        touched = skipReason === null;
      }
      if (await editTriage(row, data, actor)) touched = true;
    } catch (err) {
      result.failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (touched) {
      result.updated.push({
        id: row.id,
        displayId: formatIssueRef(prefixes.get(row.projectId) ?? null, row.issSeq),
        ...(skipReason ? { skipReason } : {}),
      });
    } else {
      result.skipped.push({ id: row.id, reason: skipReason ?? 'no_op' });
    }
  }

  if (terminal.length > 0) await publishUnblockCascade(terminal);
  return result;
}

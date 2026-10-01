import { inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { staleBase } from '../project-config/documents.js';
import {
  checkWorkflow,
  duplicateWorkflowRefusal,
  parseWorkflow,
  type WorkflowRefusal,
  workflowIdentityRefusals,
  workflowWriterRefusal,
} from './rules.js';
import { type WorkflowWrite, workflowWriteSchema } from './schema.js';
import {
  insertWorkflow,
  lockWorkflows,
  readWorkflow,
  replaceWorkflow,
  type StoredWorkflow,
  workflowHolding,
  workflowsOf,
} from './store.js';

export interface WorkflowWriter {
  userId: string;
  agency: ActorAgency;
}

export type WorkflowOutcome =
  | { ok: true; row: StoredWorkflow; document: WorkflowWrite; created: boolean }
  | { ok: false; refusals: WorkflowRefusal[] };

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

function storedWorkflow(row: StoredWorkflow): WorkflowWrite {
  const parsed = workflowWriteSchema.safeParse(row.document);
  if (!parsed.success) {
    throw new Error(
      `workflows: stored workflow ${row.id} no longer parses as workflow-v1; the store holds a shape this core cannot read and it is not guessed at.`,
    );
  }
  return parsed.data;
}

async function assertWriter(writer: WorkflowWriter, projectId: string): Promise<void> {
  const role = (await effectiveProjectRole(writer.userId, projectId))?.role ?? null;
  const refusal = workflowWriterRefusal({ ...writer, role }, projectId);
  if (refusal) {
    throw new HTTPException(403, {
      message: refusal.detail,
      cause: { code: refusal.code, details: { refusals: [refusal] } },
    });
  }
}

export async function createWorkflow(input: {
  projectId: string;
  writer: WorkflowWriter;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WorkflowOutcome> {
  const { projectId, writer, baseRevision, raw } = input;
  await assertWriter(writer, projectId);
  if (baseRevision !== null) {
    return {
      ok: false,
      refusals: [
        {
          code: 'STALE_BASE',
          path: '/baseRevision',
          detail: `this creates a workflow, which has no revision to base on; send baseRevision null, not ${baseRevision}.`,
        },
      ],
    };
  }
  const parsed = parseWorkflow(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const refusals = checkWorkflow(doc);
  if (refusals.length > 0) return { ok: false, refusals };
  return db.transaction(async (tx) => {
    await lockWorkflows(tx, projectId);
    const holding = await workflowHolding(tx, projectId, doc.flow);
    if (holding) return { ok: false, refusals: [duplicateWorkflowRefusal(doc.flow, holding)] };
    const row = await insertWorkflow(tx, doc, writer.userId);
    return { ok: true, row, document: doc, created: true };
  });
}

export async function updateWorkflow(input: {
  projectId: string;
  id: string;
  writer: WorkflowWriter;
  baseRevision: number | null;
  raw: unknown;
}): Promise<WorkflowOutcome> {
  const { projectId, id, writer, baseRevision, raw } = input;
  await assertWriter(writer, projectId);
  const parsed = parseWorkflow(raw, projectId);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  return db.transaction(async (tx) => {
    await lockWorkflows(tx, projectId);
    const row = await readWorkflow(tx, id);
    if (!row || row.projectId !== projectId) {
      throw notFound(`project ${projectId} holds no workflow ${id}`);
    }
    if (row.revision !== baseRevision) {
      return { ok: false, refusals: [staleBase(baseRevision, row.revision)] };
    }
    const stored = storedWorkflow(row);
    const refusals = [...workflowIdentityRefusals(stored, doc), ...checkWorkflow(doc)];
    if (refusals.length > 0) return { ok: false, refusals };
    if (JSON.stringify(stored) === JSON.stringify(doc)) {
      return { ok: true, row, document: stored, created: false };
    }
    const next = await replaceWorkflow(tx, {
      id,
      revision: row.revision,
      doc,
      userId: writer.userId,
    });
    return { ok: true, row: next, document: doc, created: false };
  });
}

export function workflowView(row: StoredWorkflow, document: WorkflowWrite, writerName?: string) {
  return {
    revision: row.revision,
    writer: row.writtenByUser,
    writerName: writerName ?? row.writtenByUser,
    document: {
      ...document,
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

export async function listWorkflowsAs(userId: string, projectId: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const rows = await workflowsOf(db, projectId);
  const names = await writerNames(rows);
  return rows.map((row) => workflowView(row, storedWorkflow(row), names.get(row.writtenByUser)));
}

export async function readWorkflowAs(userId: string, projectId: string, id: string) {
  await assertProjectAccess(projectId, userId, 'viewer');
  const row = await readWorkflow(db, id);
  if (!row || row.projectId !== projectId) {
    throw notFound(`project ${projectId} holds no workflow ${id}`);
  }
  const names = await writerNames([row]);
  return workflowView(row, storedWorkflow(row), names.get(row.writtenByUser));
}

async function writerNames(rows: readonly StoredWorkflow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.writtenByUser))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.displayName ?? u.email]));
}

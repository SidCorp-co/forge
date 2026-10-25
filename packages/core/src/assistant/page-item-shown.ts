/**
 * What the page beside the chat shows of a work or Product record (`page-item.ts:loadPageItem`): the
 * issue, requirement, feedback, workflow or mockup the browser names, read in the turn's project.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { rowIn as feedbackRowIn } from '../feedback/index.js';
import { isUuid, resolveIssueRouteRef } from '../issues/index.js';
import { mockupForChat } from '../mockups/index.js';

/** A lookup that answered "no such record" (404, or a key of the wrong shape); anything else is thrown on. */
export function missing(err: unknown): null {
  if (err instanceof HTTPException && (err.status === 404 || err.status === 400)) return null;
  throw err;
}

/**
 * What a record's page shows of it that the model needs to know which one is meant: its metadata
 * (status, its own kind, revisions), which reaches the model at every data level, and its content
 * (the title), which goes through the egress rule of the record's surface. A record's own `kind`
 * is carried under its own name (`feedbackKind`, `workflowKind`), never as `kind`, which names
 * the page item's kind.
 */
export type Shown = {
  key: string;
  meta: Record<string, unknown>;
  content: { title: unknown } & Record<string, unknown>;
} | null;

export async function issueShown(projectId: string, key: string, userId: string): Promise<Shown> {
  try {
    const row = await resolveIssueRouteRef(key, projectId, userId);
    if (row.projectId !== projectId) return null;
    return { key, meta: { status: row.status }, content: { title: row.title } };
  } catch (err) {
    return missing(err);
  }
}

export async function requirementShown(projectId: string, key: string): Promise<Shown> {
  const seq = Number(/^REQ-(\d+)$/.exec(key)?.[1]);
  if (!Number.isSafeInteger(seq)) return null;
  const [row] = await db
    .select({
      seq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      revision: requirements.currentRevision,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, seq)))
    .limit(1);
  if (!row) return null;
  return {
    key: requirementKey(row.seq),
    meta: { status: row.status, revision: row.revision },
    content: { title: row.title },
  };
}

export async function feedbackShown(projectId: string, key: string): Promise<Shown> {
  try {
    const row = await feedbackRowIn(db, projectId, key);
    return {
      key: feedbackKey(row.fbSeq),
      meta: { feedbackKind: row.kind, status: row.status },
      content: { title: row.title },
    };
  } catch (err) {
    return missing(err);
  }
}

export async function workflowShown(projectId: string, key: string): Promise<Shown> {
  const [row] = await db
    .select({
      flow: projectWorkflows.flow,
      kind: projectWorkflows.kind,
      document: projectWorkflows.document,
      designStatus: projectWorkflows.designStatus,
      revision: projectWorkflows.revision,
      approvedRevision: projectWorkflows.approvedRevision,
    })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        isUuid(key) ? eq(projectWorkflows.id, key) : eq(projectWorkflows.flow, key),
      ),
    )
    .limit(1);
  if (!row) return null;
  const title = (row.document as { title?: unknown } | null)?.title;
  return {
    key: row.flow,
    meta: {
      workflowKind: row.kind,
      designStatus: row.designStatus,
      revision: row.revision,
      approvedRevision: row.approvedRevision,
    },
    content: { title: typeof title === 'string' ? title : null },
  };
}

export async function mockupShown(projectId: string, key: string, userId: string): Promise<Shown> {
  // a chat about a mockup reads it as the asker; what leaves is read with the assistant's agency
  const shown = await mockupForChat(projectId, key, { userId, agency: 'agent' });
  if (!shown) return null;
  return {
    key: shown.key,
    meta: shown.meta,
    content: { title: shown.content.title, ...shown.content },
  };
}

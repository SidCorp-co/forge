/**
 * The record the page beside the chat is about, loaded by core for the turn (REQ-30 BC-6, chat-turn
 * r2 step `context`). The browser names only the kind and the key its page is addressed by; what the
 * model reads of the record is read here, in the turn's own project, as the asker, and through the
 * egress surface its kind declares. A key that names nothing is said, never dropped: a turn told
 * nothing would answer about the project as though no page were open.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import {
  describeUiSnapshot,
  type UiPageItem,
  type UiPageItemKind,
} from '@forge/contracts/ui-actions';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { rowIn as feedbackRowIn } from '../feedback/index.js';
import { isUuid, resolveIssueRouteRef } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf, type EgressSurface, egressAt } from '../lib/data-egress.js';
import { holds } from '../permissions/index.js';
import { latestUiSnapshot } from './ui-snapshot.js';

/** The surface each kind's content leaves through (`lib/data-egress.ts:EGRESS_SURFACES`). */
const SURFACE: Record<UiPageItemKind, EgressSurface> = {
  issue: 'issue',
  requirement: 'requirement',
  feedback: 'feedback',
  workflow: 'design',
};

export type LoadedPageItem =
  | ({ kind: UiPageItemKind; key: string; found: true } & Record<string, unknown>)
  | { kind: UiPageItemKind; key: string; found: false; reason: string };

/** A lookup that answered "no such record" (404, or a key of the wrong shape); anything else is thrown on. */
function missing(err: unknown): null {
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
type Shown = { key: string; meta: Record<string, unknown>; content: { title: unknown } } | null;

async function issueShown(projectId: string, key: string, userId: string): Promise<Shown> {
  try {
    const row = await resolveIssueRouteRef(key, projectId, userId);
    if (row.projectId !== projectId) return null;
    return { key, meta: { status: row.status }, content: { title: row.title } };
  } catch (err) {
    return missing(err);
  }
}

async function requirementShown(projectId: string, key: string): Promise<Shown> {
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

async function feedbackShown(projectId: string, key: string): Promise<Shown> {
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

async function workflowShown(projectId: string, key: string): Promise<Shown> {
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

function shownOf(projectId: string, item: UiPageItem, userId: string): Promise<Shown> {
  switch (item.kind) {
    case 'issue':
      return issueShown(projectId, item.key, userId);
    case 'requirement':
      return requirementShown(projectId, item.key);
    case 'feedback':
      return feedbackShown(projectId, item.key);
    case 'workflow':
      return workflowShown(projectId, item.key);
  }
}

/** The page's record as the turn reads it: found within the asker's read, or why it is not there. */
export async function loadPageItem(
  projectId: string,
  userId: string,
  item: UiPageItem,
): Promise<LoadedPageItem> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access || !holds(access, 'project.read')) {
    return {
      kind: item.kind,
      key: item.key,
      found: false,
      reason: `the asker may not read project ${projectId}, so ${item.key} was not loaded`,
    };
  }
  const shown = await shownOf(projectId, item, userId);
  if (!shown) {
    return {
      kind: item.kind,
      key: item.key,
      found: false,
      reason: `this project holds no ${item.kind} ${item.key}: the page names a record the turn could not find`,
    };
  }
  const level = await dataPolicyOf(projectId);
  const out = egressAt(level, SURFACE[item.kind], shown.content, `${item.kind} ${shown.key}`);
  // the metadata stays at every level; the content the policy keeps in is said withheld, not sent
  const content = out.ok ? out.value : { withheld: out.refusal.detail };
  return { ...shown.meta, ...content, kind: item.kind, key: shown.key, found: true };
}

/**
 * The page the person was on at their newest message, as the turn's page context, with the record
 * it is about loaded; null where the browser sent no snapshot. Both modes read this one object.
 */
export async function turnPageContext(args: {
  conversationId: string;
  projectId: string;
  userId: string;
}): Promise<Record<string, unknown> | null> {
  const snapshot = latestUiSnapshot(args.conversationId);
  if (!snapshot) return null;
  const base = { sees: describeUiSnapshot(snapshot), snapshot };
  if (!snapshot.item) return base;
  const item = await loadPageItem(args.projectId, args.userId, snapshot.item);
  return {
    ...base,
    about: `The person has ${item.kind} ${item.key} open beside the chat. "This", "here" and "it" mean that ${item.kind} unless they name another; answer about it by its key, and read it with your tools before saying what it holds.`,
    item,
  };
}

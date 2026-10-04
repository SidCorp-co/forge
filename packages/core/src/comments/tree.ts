import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { actorKey, type RecordEvent, type ResolvedActor, recordOfEvent } from '../issues/index.js';
import { type ForgeRecord, parseForgeRecord } from '../messaging/forge-record.js';
import type { RecordLens } from '../messaging/record-screen.js';

/**
 * The record a comment carries, with the reading its project is drawn under, and where its content
 * was read from: the typed event it was mirrored into, or the fence itself for a legacy comment.
 */
type CommentRecord = ForgeRecord & {
  readonly lens: RecordLens;
  readonly source: 'event' | 'comment';
  readonly eventId: string | null;
};

export interface CommentRow {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId?: string | null;
  body: string;
  /** ISS-898 renderer the body was stored for; absent reads as `markdown`. */
  format?: string | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// A lightweight attachment view carried on each comment node. Mirrors the
// shape returned by persistCommentAttachment (plus the download `url`) so the
// tree endpoint and the per-file upload endpoint stay consistent.
export interface CommentAttachmentLite {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: Date;
}

export type CommentNode<R extends CommentRow = CommentRow> = R & {
  replies: CommentNode<R>[];
  attachments: CommentAttachmentLite[];
  nodes: BodyNode[] | null;
  record: CommentRecord | null;
  /** What the comment is about: its arc target. Derived from the row, never stored twice. */
  scope: 'issue';
  // ISS-519 — resolved author identity (email for a human, device name + Agent
  // marker for an agent comment). Optional so existing builders/tests that
  // don't enrich the tree still compile; the comments route attaches it (null
  // when the actor could not be resolved).
  author?: ResolvedActor | null;
};

/**
 * A comment's record: the event's content where the record was mirrored into one, placed where the
 * fence sits in the body so the prose around it keeps its place.
 *
 * cm:hack — the fence parse stands in for a record that has no event: a comment written before
 * migration 0347, read for history. Ends with the backfill that gives every such record an event
 * (`issues/record-events/history.ts`).
 */
function recordOf(
  body: string,
  event: RecordEvent | undefined,
  lens: RecordLens,
): CommentRecord | null {
  const fence = parseForgeRecord(body);
  if (event) {
    return {
      ...recordOfEvent(event),
      at: fence?.at ?? 0,
      to: fence?.to ?? 0,
      lens,
      source: 'event',
      eventId: event.id,
    };
  }
  return fence ? { ...fence, lens, source: 'comment', eventId: null } : null;
}

export function buildCommentTree<R extends CommentRow>(
  rows: R[],
  attachmentsByCommentId?: Map<string, CommentAttachmentLite[]>,
  lens: RecordLens = 'product',
  eventsByComment: ReadonlyMap<string, RecordEvent> = new Map(),
): CommentNode<R>[] {
  const byId = new Map<string, CommentNode<R>>();
  for (const r of rows) {
    byId.set(r.id, {
      ...r,
      replies: [],
      attachments: attachmentsByCommentId?.get(r.id) ?? [],
      nodes: bodyNodes(r.body, r.format),
      record: recordOf(r.body, eventsByComment.get(r.id), lens),
      scope: 'issue',
    });
  }
  const roots: CommentNode<R>[] = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    if (r.parentId == null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(r.parentId);
    if (parent) parent.replies.push(node);
  }
  return roots;
}

function walkCommentTree<R extends CommentRow>(
  nodes: CommentNode<R>[],
  visit: (node: CommentNode<R>) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.replies.length > 0) walkCommentTree(node.replies, visit);
  }
}

export function attachAuthors(
  nodes: CommentNode<CommentRow>[],
  resolved: Map<string, ResolvedActor>,
): void {
  walkCommentTree(nodes, (node) => {
    const actor = resolved.get(
      node.authorDeviceId
        ? actorKey('device', node.authorDeviceId)
        : actorKey('user', node.authorId),
    );
    node.author = actor ?? null;
  });
}

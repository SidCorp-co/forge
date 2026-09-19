import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { actorKey, type ResolvedActor } from '../issues/actor-identity.js';
import { type ForgeRecord, parseForgeRecord } from '../messaging/forge-record.js';
import type { RecordLens } from '../messaging/record-screen.js';

/** The record a comment carries, with the reading its project is drawn under. */
export type CommentRecord = ForgeRecord & { readonly lens: RecordLens };

export interface CommentRow {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId?: string | null;
  // ISS-969 — who was at the keyboard, taken from the credential at write time.
  // NULL is "written before this column existed", never 'human'. Optional for the
  // same reason as `authorDeviceId`.
  authorAgency?: ActorAgency | null;
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
  // ISS-519 — resolved author identity (email for a human, device name + Agent
  // marker for an agent comment). Optional so existing builders/tests that
  // don't enrich the tree still compile; the comments route attaches it (null
  // when the actor could not be resolved).
  author?: ResolvedActor | null;
};

export function buildCommentTree<R extends CommentRow>(
  rows: R[],
  attachmentsByCommentId?: Map<string, CommentAttachmentLite[]>,
  lens: RecordLens = 'product',
): CommentNode<R>[] {
  const byId = new Map<string, CommentNode<R>>();
  for (const r of rows) {
    const record = parseForgeRecord(r.body);
    byId.set(r.id, {
      ...r,
      replies: [],
      attachments: attachmentsByCommentId?.get(r.id) ?? [],
      nodes: bodyNodes(r.body, r.format),
      record: record ? { ...record, lens } : null,
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

export function walkCommentTree<R extends CommentRow>(
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
    node.author = actor
      ? { ...actor, isAgent: node.authorAgency === 'agent' || actor.isAgent }
      : null;
  });
}

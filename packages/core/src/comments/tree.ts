import type { ResolvedActor } from '../issues/actor-resolution.js';

export interface CommentRow {
  id: string;
  issueId: string;
  authorId: string;
  // ISS-519 — non-null when the comment was posted by an agent/device. The
  // authoritative "this is an agent action" marker (authorId always points at
  // the device's human owner). Optional so flat-list/REST builders that don't
  // select it still satisfy the type.
  authorDeviceId?: string | null;
  body: string;
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

export interface CommentNode extends CommentRow {
  replies: CommentNode[];
  attachments: CommentAttachmentLite[];
  // ISS-519 — resolved author identity (email for a human, device name + Agent
  // marker for an agent comment). Optional so existing builders/tests that
  // don't enrich the tree still compile; the comments route attaches it (null
  // when the actor could not be resolved).
  author?: ResolvedActor | null;
}

// Assembles a flat list of comment rows into a parent → replies tree. A row
// is a root only when its `parentId` is null; replies whose parent is missing
// from the input set are dropped rather than promoted to roots, so a partial
// fetch (e.g. cap-truncated query) cannot make a reply masquerade as a
// top-level comment. Sibling order matches input order — callers should pre-sort.
//
// `attachmentsByCommentId` maps a comment id to its attachments; nodes with no
// entry get an empty array. Callers that don't care about attachments may omit
// it entirely.
export function buildCommentTree(
  rows: CommentRow[],
  attachmentsByCommentId?: Map<string, CommentAttachmentLite[]>,
): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const r of rows)
    byId.set(r.id, {
      ...r,
      replies: [],
      attachments: attachmentsByCommentId?.get(r.id) ?? [],
    });
  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    if (r.parentId == null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(r.parentId);
    if (parent) parent.replies.push(node);
    // else: orphan reply (parent beyond cap) — drop silently
  }
  return roots;
}

// Depth-first walk over a comment tree (roots, then each node's nested
// replies). Used to attach resolved authors after the tree is built.
export function walkCommentTree(
  nodes: CommentNode[],
  visit: (node: CommentNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.replies.length > 0) walkCommentTree(node.replies, visit);
  }
}

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
  // ISS-519, narrowed by ISS-932 wave 4 — non-null names the BOX a credential was
  // issued to, which answers *where* and not *who*. It is NOT the agent test; see
  // `authorAgency` below. Optional so flat-list/REST builders that don't select it
  // still satisfy the type.
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
  // cm:guard the tree ships on EVERY comment surface because web-v2 has no `@forge/core` dependency and cannot parse a component body; a builder that drops it renders literal `<forge-…>` markup with every test still green (ISS-967). `null` is markdown, or bytes this build's scanner cannot read.
  nodes: BodyNode[] | null;
  // cm:guard the parsed `forge-record` block travels for the SAME reason `nodes` does, and it is the SAME parse the comment-write door screened: web-v2 re-deriving it would be a second parser that can disagree with the one that refused the comment, which is the defect ISS-1089 replaces rather than a step toward it. `null` is a comment carrying no fence.
  record: CommentRecord | null;
  // ISS-519 — resolved author identity (email for a human, device name + Agent
  // marker for an agent comment). Optional so existing builders/tests that
  // don't enrich the tree still compile; the comments route attaches it (null
  // when the actor could not be resolved).
  author?: ResolvedActor | null;
};

// Assembles a flat list of comment rows into a parent → replies tree. A row
// is a root only when its `parentId` is null; replies whose parent is missing
// from the input set are dropped rather than promoted to roots, so a partial
// fetch (e.g. cap-truncated query) cannot make a reply masquerade as a
// top-level comment. Sibling order matches input order — callers should pre-sort.
//
// `attachmentsByCommentId` maps a comment id to its attachments; nodes with no
// entry get an empty array. Callers that don't care about attachments may omit
// it entirely.
// cm:guard `lens` is resolved ONCE by the caller and handed in, not read per comment: it is a
// property of the project, one query, and a tree builder that fetched it per row would make a page
// of forty comments forty round trips for one answer (ISS-1089). It defaults to `product` for the
// same reason `projectLens` fails to `product` — the stricter reading is the safe one to be wrong in.
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
    // cm:guard a reply whose parent is not in `rows` is DROPPED, never promoted to a root — a cap-truncated page would otherwise present a mid-thread reply as a top-level comment, which reads as a different statement than the one that was made.
    if (parent) parent.replies.push(node);
  }
  return roots;
}

// Depth-first walk over a comment tree (roots, then each node's nested
// replies). Used to attach resolved authors after the tree is built.
export function walkCommentTree<R extends CommentRow>(
  nodes: CommentNode<R>[],
  visit: (node: CommentNode<R>) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.replies.length > 0) walkCommentTree(node.replies, visit);
  }
}

// cm:guard authorship is the TOKEN's — the IDENTITY is resolved from the credential's device or its owner, and nothing per-comment overrides who the author is. `author_agency` is not such an override and reintroduces nothing: it is what the credential established at write time, stored because a comment is read long after its request is gone, and `comments/service.ts:updateCommentBody` already re-reads it rather than the editor's. What must not come back is `comments.is_ai` — a flag a WRITER asserted about itself, which disagreed with the token on 3,172 of 23,414 rows (measured 2026-09-04) because an agent holding the owner's PAT wrote `true` on the owner's own identity.
// cm:guard the `||` mirrors `issues/activity-routes.ts:isAgentForRow` and is an OR for that reader's reason, NOT for `issues/creator.ts:creatorIsAgent`'s: `comments.author_agency` is nullable with no backfill, so NULL is no evidence and the resolver's principal floor must still answer. Reading the column ALONE would un-mark every comment written before ISS-969, and `attachAuthors` reading neither is how a comment an agent wrote on a person's PAT rendered with no marker at all while the truthful column sat on the wire (ISS-1093).
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

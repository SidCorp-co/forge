export interface CommentRow {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentNode extends CommentRow {
  replies: CommentNode[];
}

// Assembles a flat list of comment rows into a parent → replies tree. A row
// is a root only when its `parentId` is null; replies whose parent is missing
// from the input set are dropped rather than promoted to roots, so a partial
// fetch (e.g. cap-truncated query) cannot make a reply masquerade as a
// top-level comment. Sibling order matches input order — callers should pre-sort.
export function buildCommentTree(rows: CommentRow[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const r of rows) byId.set(r.id, { ...r, replies: [] });
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

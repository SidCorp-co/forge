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

// Assembles a flat list of comment rows into a parent → replies tree. Rows
// referencing an unknown parent become roots (defensive against partial
// fetches). Sibling order matches input order — callers should pre-sort.
export function buildCommentTree(rows: CommentRow[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const r of rows) byId.set(r.id, { ...r, replies: [] });
  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (parent) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

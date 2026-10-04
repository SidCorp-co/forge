interface TreeNode {
  id: string;
  parentId?: string | null;
}

/** The module's ancestors, outermost first; a parent outside `nodes` or a cycle ends the walk. */
export function ancestorsOf<N extends TreeNode>(nodes: readonly N[], id: string): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: N[] = [];
  const seen = new Set([id]);
  let at = byId.get(id)?.parentId ?? null;
  while (at !== null && !seen.has(at)) {
    const node = byId.get(at);
    if (!node) break;
    out.unshift(node);
    seen.add(at);
    at = node.parentId ?? null;
  }
  return out;
}

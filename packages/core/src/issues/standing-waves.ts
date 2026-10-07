/** The wave each open issue sits in over the live `blocks` edges, for the issue list and the master's dispatch. */

interface WaveNode {
  id: string;
  /** It holds its dependents (`blocked-by.ts:blockerUnsettledSql`). */
  holds: boolean;
  /** Ids of the issues holding this one back over live `blocks` edges. */
  blockedBy: readonly string[];
}

// a wave is the layer the master can dispatch from: an open issue with no open blocker is
// wave 0; otherwise one more than its deepest open blocker. A blocker that is settled or done holds
// nothing back. An issue on a cycle (or downstream of one) has no wave: null, never a guess.
export function wavesOf(nodes: readonly WaveNode[]): Map<string, number | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number | null>();
  const visiting = new Set<string>();
  const open = (id: string) => byId.get(id)?.holds === true;
  const visit = (id: string): number | null => {
    if (out.has(id)) return out.get(id) ?? null;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const n = byId.get(id) as WaveNode;
    let wave: number | null = 0;
    for (const b of n.blockedBy) {
      if (!open(b)) continue;
      const w = visit(b);
      if (w === null) {
        wave = null;
        break;
      }
      wave = Math.max(wave, w + 1);
    }
    visiting.delete(id);
    out.set(id, wave);
    return wave;
  };
  for (const n of nodes) if (open(n.id)) visit(n.id);
  return out;
}

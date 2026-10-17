/**
 * ISS-1421 r4 — tied hits came back in another order on a second read (run 38989416676), since a
 * read rewrites its hits' rows. Rows arrive here out of id order, as a rewritten heap can hand them.
 */

import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));

/** Any select chain the search builds ends in `limit`, which answers the planted rows. */
function chain(): unknown {
  const link: Record<string, unknown> = {};
  for (const step of ['from', 'where', 'orderBy']) link[step] = () => link;
  link.limit = async () => rows.current;
  return link;
}

vi.mock('../db/client.js', () => ({ db: { select: () => chain() } }));

const { searchMemories } = await import('./search.js');

function row(id: string, distance: number): Record<string, unknown> {
  return {
    id,
    source: 'issue',
    sourceRef: `ref-${id}`,
    text: id,
    metadata: {},
    embeddedAt: new Date('2026-10-17T00:00:00Z'),
    distance,
  };
}

describe('memory search breaks a score tie by memory id (ISS-1421 r4)', () => {
  it('lists tied hits in id order whatever order the rows arrive in', async () => {
    rows.current = [row('m-1', 0.1), row('m-4', 1), row('m-2', 1), row('m-3', 1)];
    const hits = await searchMemories({ projectId: 'p', queryVec: [1, 0], topK: 4 });
    expect(hits.map((h) => h.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
  });

  it('keeps the better score first', async () => {
    rows.current = [row('m-9', 0.2), row('m-1', 0.5)];
    const hits = await searchMemories({ projectId: 'p', queryVec: [1, 0], topK: 2 });
    expect(hits.map((h) => h.id)).toEqual(['m-9', 'm-1']);
  });
});

/**
 * ISS-1336 end to end, the neighbours: every unsettled issue's nearest issues are read from stored
 * rows, and a change re-measures only the seeds it can move.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alikeMaintainer,
  call,
  embeddingsMod,
  harness,
  pendingRows,
  projectId,
  resetKit,
  rows,
  searchMod,
  seedIssue,
  startKit,
  stopKit,
} from '../helpers/backlog-index-kit.js';

beforeAll(startKit, 180_000);
afterAll(stopKit);
beforeEach(resetKit);

// Twelve issues on a circle, thirty degrees apart. A title embeds to its own point and so does its
// issue's memory row, so an issue is its own nearest and the rest order by angle.
const SEEDS = 12;
let embedCalls: string[];
let angleOfTitle: Map<string, number>;
const issueIds: string[] = [];

/** A unit vector at `degrees` on a circle in the first two dimensions, so cosine is the cosine of the angle between. */
function vectorAt(degrees: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[0] = Math.cos((degrees * Math.PI) / 180);
  v[1] = Math.sin((degrees * Math.PI) / 180);
  return v;
}

const literal = (v: number[]) => `[${v.join(',')}]`;

async function seedCircle() {
  issueIds.length = 0;
  for (let k = 0; k < SEEDS; k++) {
    const title = `alike subject ${k}`;
    angleOfTitle.set(title, k * 30);
    const id = await seedIssue(k + 1, { title });
    issueIds.push(id);
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
      VALUES (${projectId}, 'issue', ${id}, ${title}, ${literal(vectorAt(k * 30))}::vector)`);
  }
}

const drainAll = async () => {
  for (let i = 0; i < 10 && (await pendingRows('alike-seed', 'alike-target')) > 0; i++) {
    await alikeMaintainer.drainAlike(projectId);
  }
};

interface NeighboursBody {
  seeds: Array<{
    issueId: string;
    displayId: string;
    stale: boolean;
    title: string;
    hits: Array<{ sourceRef: string; score: number; memoryId: string }>;
  }>;
  total: number;
  topK: number;
  next: number | null;
  index: { state: string; pending: number };
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

const neighbours = async (query = '') => {
  const res = await call(`/api/projects/${projectId}/backlog/neighbours${query}`);
  return { status: res.status, body: (await res.json()) as NeighboursBody };
};

beforeEach(() => {
  embedCalls = [];
  angleOfTitle = new Map();
  const vectorOf = (text: string) => vectorAt(angleOfTitle.get(text) ?? 0);
  embeddingsMod.resetEmbeddingsClient({
    embed: async (text: string) => {
      embedCalls.push(text);
      return vectorOf(text);
    },
    embedBatch: async (texts: string[]) => {
      embedCalls.push(...texts);
      return texts.map(vectorOf);
    },
  } as unknown as Parameters<typeof embeddingsMod.resetEmbeddingsClient>[0]);
});

describe('the neighbours read', () => {
  it('answers every unsettled issue with its stored neighbours, ranked as the sweep ranks them', async () => {
    await seedCircle();
    await drainAll();
    embedCalls.length = 0;

    const { status, body } = await neighbours('?catchUpMs=0');

    expect(status).toBe(200);
    expect(body.total).toBe(SEEDS);
    expect(body.seeds).toHaveLength(SEEDS);
    expect(body.index).toMatchObject({ state: 'fresh', pending: 0 });
    const first = body.seeds[0];
    expect(first?.hits).toHaveLength(10);
    expect(first?.hits[0]).toMatchObject({ sourceRef: issueIds[0], score: expect.closeTo(1, 4) });
    expect(first?.hits.map((h) => h.score)).toEqual(
      [...(first?.hits.map((h) => h.score) ?? [])].sort((a, b) => b - a),
    );
    expect(embedCalls).toEqual([]);
  });

  it('serves the same hits the ISS-1173 sweep finds for the same issues', async () => {
    await seedCircle();
    await drainAll();
    const stored = (await neighbours('?catchUpMs=0')).body;

    const stream = await call(`/api/projects/${projectId}/backlog/alike`);
    const { parseSseStream } = await import('../../src/assistant/providers/sse.js');
    const swept = new Map<string, Array<{ sourceRef: string; score: number }>>();
    for await (const data of parseSseStream(stream.body as ReadableStream<Uint8Array>)) {
      const frame = JSON.parse(data) as {
        type: string;
        issueId?: string;
        hits?: Array<{ sourceRef: string; score: number }>;
      };
      if (frame.type === 'item' && frame.issueId) swept.set(frame.issueId, frame.hits ?? []);
    }

    expect(swept.size).toBe(SEEDS);
    for (const seed of stored.seeds) {
      const live = swept.get(seed.issueId) ?? [];
      expect(seed.hits.map((h) => h.sourceRef)).toEqual(live.map((h) => h.sourceRef));
      for (const [i, h] of seed.hits.entries()) {
        expect(h.score).toBeCloseTo(live[i]?.score ?? Number.NaN, 4);
      }
    }
  });

  it('reads stored rows and makes no search at read time', async () => {
    await seedCircle();
    await drainAll();
    embedCalls.length = 0;
    // Nothing a search could find is left: a read that searched would answer from this, not from rows.
    await harness.db.execute(sql`DELETE FROM memories WHERE project_id = ${projectId}`);

    const { body } = await neighbours('?catchUpMs=0');

    expect(body.seeds[0]?.hits).toHaveLength(10);
    expect(body.index.state).toBe('stale');
    expect(embedCalls).toEqual([]);
  });

  it('refuses by name while an unsettled issue has no neighbour set, and heals in the next read', async () => {
    await seedCircle();
    await drainAll();
    await harness.db.execute(sql`DELETE FROM issue_alike_seeds WHERE issue_id = ${issueIds[3]}`);

    const refused = await neighbours('?catchUpMs=0');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ALIKE_INDEX_INCOMPLETE');
    expect(refused.body.details).toMatchObject({ unmeasured: 1, issues: ['ISS-4'] });
    expect(refused.body).not.toHaveProperty('seeds');

    const healed = await neighbours();
    expect(healed.status).toBe(200);
    expect(healed.body.seeds).toHaveLength(SEEDS);
  });

  it('names a seed with a pending change as stale, and one that lists a pending issue', async () => {
    await seedCircle();
    await drainAll();
    await harness.db.execute(
      sql`UPDATE issues SET title = 'alike subject 2 again' WHERE id = ${issueIds[2]}`,
    );

    const { body } = await neighbours('?catchUpMs=0');
    // Title edit changes the seed's own title: coverage is short until it is measured again.
    expect(body.code).toBe('ALIKE_INDEX_INCOMPLETE');

    await drainAll();
    angleOfTitle.set('alike subject 2 again', 60);
    await harness.db.execute(sql`
      UPDATE memories SET embedding = ${literal(vectorAt(61))}::vector
       WHERE project_id = ${projectId} AND source_ref = ${issueIds[5]}`);
    const stale = (await neighbours('?catchUpMs=0')).body;
    expect(stale.index.state).toBe('stale');
    expect(stale.seeds.find((s) => s.issueId === issueIds[5])?.stale).toBe(true);
  });

  it('pages by sequence number and refuses a topK past what an issue keeps', async () => {
    await seedCircle();
    await drainAll();

    const first = (await neighbours('?limit=5&catchUpMs=0')).body;
    expect(first.seeds).toHaveLength(5);
    expect(first.next).toBe(5);
    const rest = (await neighbours(`?limit=50&after=${first.next}&catchUpMs=0`)).body;
    expect(rest.seeds).toHaveLength(SEEDS - 5);
    expect(rest.next).toBeNull();

    const refused = await call(`/api/projects/${projectId}/backlog/neighbours?topK=11`);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/topK must be between 1 and 10/);
  });
});

describe('what a change re-measures', () => {
  it('embeds and searches for one issue, and no other, when its title changes', async () => {
    await seedCircle();
    await drainAll();
    embedCalls.length = 0;
    angleOfTitle.set('alike subject 4, reworded', 120);
    await harness.db.execute(
      sql`UPDATE issues SET title = 'alike subject 4, reworded' WHERE id = ${issueIds[4]}`,
    );

    const result = await alikeMaintainer.drainAlike(projectId);

    expect(result.embedded).toEqual([issueIds[4]]);
    expect(result.measured).toEqual([issueIds[4]]);
    expect(embedCalls).toEqual(['alike subject 4, reworded']);
  });

  it('searches again only the seeds a moved issue memory can enter or already appears in', async () => {
    await seedCircle();
    await drainAll();
    // Seed 0 sits at 0 degrees; its ten kept neighbours are everything but the two farthest points.
    // Seed 6, at 180 degrees, does not list the issue at 0 degrees: it is its antipode, at cosine -1,
    // far below the lowest score that seed kept.
    const target = issueIds[0] as string;
    const antipode = issueIds[6] as string;
    const antipodeHits =
      (await neighbours('?catchUpMs=0')).body.seeds.find((s) => s.issueId === antipode)?.hits ?? [];
    expect(antipodeHits.map((h) => h.sourceRef)).not.toContain(target);

    // The target's memory moves a few degrees: its own seed and every seed listing it are searched
    // again, and the antipode, which neither lists it nor scores it above its floor, is not.
    await harness.db.execute(sql`
      UPDATE memories SET embedding = ${literal(vectorAt(10))}::vector
       WHERE project_id = ${projectId} AND source_ref = ${target}`);
    const moved = await alikeMaintainer.drainAlike(projectId);

    expect(moved.measured).not.toContain(antipode);
    expect(moved.measured).toContain(target);
    expect(moved.measured.length).toBeLessThan(SEEDS);
    // Not searching it was right: what is stored is what a search now finds.
    const stored =
      (await neighbours('?catchUpMs=0')).body.seeds.find((s) => s.issueId === antipode)?.hits ?? [];
    const [seedRow] = await rows<{ vector: string }>(
      sql`SELECT title_embedding::text AS vector FROM issue_alike_seeds WHERE issue_id = ${antipode}`,
    );
    const fresh = await searchMod.searchMemories({
      projectId,
      topK: 10,
      sourceFilter: ['issue'],
      queryVec: JSON.parse(seedRow?.vector as string) as number[],
      memoryModel: 'flat',
    });
    expect(stored.map((h) => h.sourceRef)).toEqual(fresh.map((h) => h.sourceRef));

    // Moved to the antipode's own side, the same issue now scores above that seed's floor.
    await harness.db.execute(sql`
      UPDATE memories SET embedding = ${literal(vectorAt(185))}::vector
       WHERE project_id = ${projectId} AND source_ref = ${target}`);
    const entered = await alikeMaintainer.drainAlike(projectId);
    expect(entered.measured).toContain(antipode);
    const after =
      (await neighbours('?catchUpMs=0')).body.seeds.find((s) => s.issueId === antipode)?.hits ?? [];
    expect(after.map((h) => h.sourceRef)).toContain(target);
  });

  it('leaves the seed of a settled issue out, and removes a seed whose issue was dropped', async () => {
    await seedCircle();
    await drainAll();

    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${issueIds[7]}`);
    const result = await alikeMaintainer.drainAlike(projectId);

    expect(result.removed).toEqual([issueIds[7]]);
    const { body } = await neighbours('?catchUpMs=0');
    expect(body.total).toBe(SEEDS - 1);
    expect(body.seeds.map((s) => s.issueId)).not.toContain(issueIds[7]);
  });

  it('stops listing an archived issue as a neighbour, and lists it again when it is restored', async () => {
    await seedCircle();
    await drainAll();
    const target = issueIds[1] as string;
    const listing = async () =>
      (await neighbours('?catchUpMs=0')).body.seeds.find((s) => s.issueId === issueIds[0])?.hits ??
      [];
    expect((await listing()).map((h) => h.sourceRef)).toContain(target);

    await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${target}`);
    await drainAll();
    expect((await listing()).map((h) => h.sourceRef)).toContain(target);

    await harness.db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${target}`);
    expect((await neighbours('?catchUpMs=0')).body.index.state).toBe('stale');
    await drainAll();
    expect((await listing()).map((h) => h.sourceRef)).not.toContain(target);

    await harness.db.execute(sql`UPDATE issues SET archived_at = NULL WHERE id = ${target}`);
    await drainAll();
    expect((await listing()).map((h) => h.sourceRef)).toContain(target);
  });
});

describe('what one pass is allowed to cost', () => {
  it('measures a bounded number of seeds per pass and leaves the rest marked, so a budget is honoured', async () => {
    const wanted = alikeMaintainer.ALIKE_SEEDS_PER_PASS + 5;
    for (let k = 0; k < wanted; k++) {
      angleOfTitle.set(`bounded ${k}`, (k * 7) % 360);
      await seedIssue(k + 1, { title: `bounded ${k}` });
    }
    await harness.db.execute(sql`DELETE FROM backlog_index_dirty WHERE project_id = ${projectId}`);
    await harness.db.execute(
      sql`SELECT backlog_index_mark('alike-seed', ${projectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'test: whole project')`,
    );
    embedCalls.length = 0;

    const first = await alikeMaintainer.drainAlike(projectId);

    expect(first.measured).toHaveLength(alikeMaintainer.ALIKE_SEEDS_PER_PASS);
    expect(embedCalls).toHaveLength(alikeMaintainer.ALIKE_SEEDS_PER_PASS);
    expect(await pendingRows('alike-seed')).toBe(5);
    expect((await neighbours('?catchUpMs=0')).body.code).toBe('ALIKE_INDEX_INCOMPLETE');

    const second = await alikeMaintainer.drainAlike(projectId);
    expect(second.measured).toHaveLength(5);
    expect(await pendingRows('alike-seed')).toBe(0);
    expect((await neighbours('?catchUpMs=0')).body.total).toBe(wanted);
  });
});

describe('what a read spends catching up', () => {
  it('stops measuring when its budget is spent, refuses by name, and leaves the rest marked', async () => {
    const wanted = alikeMaintainer.ALIKE_SEEDS_PER_PASS + 5;
    for (let k = 0; k < wanted; k++) {
      angleOfTitle.set(`slow ${k}`, (k * 11) % 360);
      await seedIssue(k + 1, { title: `slow ${k}` });
    }
    await harness.db.execute(sql`DELETE FROM backlog_index_dirty WHERE project_id = ${projectId}`);
    await harness.db.execute(
      sql`SELECT backlog_index_mark('alike-seed', ${projectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'test: whole project')`,
    );
    const vectorOf = (text: string) => vectorAt(angleOfTitle.get(text) ?? 0);
    embeddingsMod.resetEmbeddingsClient({
      embed: async (text: string) => vectorOf(text),
      // The budget is spent by the clock, not by how long a machine takes: the clock stands still
      // until the first batch is embedded, and that batch moves it past the budget, so the pass
      // always starts, always measures one seed, and never has time for a second.
      embedBatch: async (texts: string[]) => {
        vi.setSystemTime(Date.now() + 1_000);
        return texts.map(vectorOf);
      },
    } as unknown as Parameters<typeof embeddingsMod.resetEmbeddingsClient>[0]);

    vi.useFakeTimers({ toFake: ['Date'] });
    const { status, body } = await neighbours('?catchUpMs=100').finally(() => vi.useRealTimers());

    expect(status).toBe(409);
    expect(body.code).toBe('ALIKE_INDEX_INCOMPLETE');
    const [counted] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue_alike_seeds WHERE project_id = ${projectId}`,
    );
    const n = Number(counted?.n);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(alikeMaintainer.ALIKE_SEEDS_PER_PASS);
    expect(await pendingRows('alike-seed')).toBeGreaterThan(0);

    await drainAll();
    expect((await neighbours('?catchUpMs=0')).body.total).toBe(wanted);
  });
});

describe('what one read is allowed to see', () => {
  it('answers from one snapshot, so a commit in the middle of a read cannot split it', async () => {
    await seedCircle();
    await drainAll();
    const dirty = await import('../../src/issues/backlog/index-dirty.js');
    const original = dirty.pendingFor;
    const spy = vi.spyOn(dirty, 'pendingFor').mockImplementation(async (...args) => {
      const seen = await original(...args);
      await harness.db.execute(
        sql`UPDATE issues SET title = 'reworded mid read' WHERE id = ${issueIds[0]}`,
      );
      return seen;
    });
    try {
      const { status, body } = await neighbours('?catchUpMs=0');
      expect(status).toBe(200);
      // The title and the neighbours it was measured with are the same moment's: a title the hits
      // were not measured for, beside an index reported fresh, is the split this refuses.
      expect(body.seeds[0]?.title).toBe('alike subject 0');
      expect(body.index.state).toBe('fresh');
    } finally {
      spy.mockRestore();
    }
  });
});

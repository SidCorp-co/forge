/**
 * ISS-962 (agenfold, 2026-11-04): the 0.123.0 batch (roster ISS-127, ISS-128, ISS-142) reported
 * a939c3f as the head it cut, and Forge owed v0.123.0 there. a939c3f is ISS-144's landing, and ISS-144
 * was held for the 0.124.0 draft: production ran it while its record claimed 0.124.0, and nothing said.
 *
 * Planted through the app's own routes against real Postgres: a two-issue roster, and a third gate
 * issue landed after it on the same branch and held out of the roster; the run reports the third's
 * landing as its head. The report is refused by name before any tag is owed. A head at the roster's
 * own top commit is unaffected, a gate issue landed on a branch the head does not descend from is not
 * named, and one whose ancestry nobody reads is kept on the range as unchecked and named where it is
 * read. The repository's history is planted as the ancestry reader answers it.
 *
 * @direct-test-of packages/core/src/release-batch/range-outside.ts
 * @direct-test-of packages/core/src/release-batch/shipped-range.ts
 * @direct-test-of packages/core/src/release-batch/queries.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

/** The commit the release before this one served: the range's base. */
const BASE = 'b0'.repeat(20);
/** The roster's two landings, then ISS-144's after them on the same branch, as a939c3f was. */
const R1 = 'a1'.repeat(20);
const R2 = 'a2'.repeat(20);
const LATER = 'a939c3f0'.repeat(5);
/** A landing on a branch off the base that none of the above descends from. */
const SIDE = 'c5'.repeat(20);

/** What each commit holds, itself included: base <- R1 <- R2 <- LATER, and base <- SIDE. */
const HOLDS: Record<string, readonly string[]> = {
  [BASE]: [BASE],
  [R1]: [BASE, R1],
  [R2]: [BASE, R1, R2],
  [LATER]: [BASE, R1, R2, LATER],
  [SIDE]: [BASE, SIDE],
};

const ancestry = vi.hoisted(() => ({ silent: null as string | null }));

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async () => ({
    kind: 'box',
    why: 'the planted box',
    reader: {
      async ask(pairs: readonly { commit: string; release: string }[]) {
        if (ancestry.silent) return { silent: ancestry.silent };
        return new Map(
          pairs.map((p) => [
            `${p.commit}@${p.release}`,
            HOLDS[p.release] ? HOLDS[p.release]?.includes(p.commit) : { unread: 'no such commit' },
          ]),
        );
      },
      witness: () => ({ via: 'source-host' }),
    },
  }),
}));

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  ancestry.silent = null;
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
  // the release before this one, which served the base
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${projectId}, 'system', 'completed', now() - interval '2 days', '0.0.9', now() - interval '2 days',
            ${JSON.stringify({ source: 'release-batch', finish: { requestId: 'r', state: 'finished', commit: BASE, version: 1 } })}::jsonb)
  `);
});

const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

/** A gate issue landed at `commit`, `minutesAgo` minutes ago. */
async function landed(commit: string, minutesAgo: number): Promise<string> {
  const id = await fx.insertIssue();
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = ${commit}, merged_at = now() - make_interval(mins => ${minutesAgo})
     WHERE id = ${id}
  `);
  return id;
}

async function keyOf(id: string): Promise<string> {
  const [row] = await rows<{ seq: number }>(
    sql`SELECT iss_seq AS seq FROM issues WHERE id = ${id}`,
  );
  return `ISS-${row?.seq}`;
}

/** The roster R1, R2 cut as a release batch, and the gate issue landed after it held out of it. */
async function world() {
  const roster = [await landed(R1, 30), await landed(R2, 20)];
  const later = await landed(LATER, 10);
  const r = await call('POST', '/release-batches', { issueIds: roster });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { runId: String(r.body.runId), roster, later };
}

const report = (runId: string, head: string) =>
  call('POST', `/release-batches/${runId}/range`, { base: BASE, head, changes: [], files: [] });

async function runMetadata(runId: string) {
  const [row] = await rows<{ tag: unknown; range: unknown }>(sql`
    SELECT metadata -> 'tagOwed' AS tag, metadata -> 'range' AS range FROM pipeline_runs WHERE id = ${runId}
  `);
  return row;
}

describe('a head carrying a gate issue outside the roster is refused by name before its tag (ISS-962)', () => {
  it('refuses the report naming the later issue and its landing, keeping nothing and owing no tag', async () => {
    const w = await world();

    const r = await report(w.runId, LATER);

    expect(r.status, JSON.stringify(r.body)).toBe(409);
    const refusal = JSON.stringify(r.body);
    expect(refusal).toContain('RELEASE_RANGE_OUTSIDE_ROSTER');
    expect(refusal).toContain(`${await keyOf(w.later)} (landed at a939c3f)`);
    expect(refusal).toContain('do not deploy');
    for (const id of w.roster) expect(refusal).not.toContain(`${await keyOf(id)} (landed`);
    expect(await runMetadata(w.runId)).toEqual({ tag: null, range: null });
  });

  it('keeps a head at the roster own top commit, with the tag owed there and nothing unchecked', async () => {
    const w = await world();

    const r = await report(w.runId, R2);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'read', head: R2, unchecked: [] });
    const kept = await runMetadata(w.runId);
    expect(kept?.tag).toMatchObject({ commit: R2, from: 'range' });
    const batch = await call('GET', `/release-batches/${w.runId}`);
    expect(batch.body.rangeUnchecked).toEqual([]);
  });

  it('never names a gate issue landed on a branch the head does not descend from', async () => {
    const w = await world();
    await landed(SIDE, 5);

    const r = await report(w.runId, R2);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.unchecked).toEqual([]);
  });

  it('keeps a gate issue nobody could place as unchecked, named with why on the batch read', async () => {
    const w = await world();
    ancestry.silent = 'no box holding the checkout answered';
    const unmarked = await fx.insertIssue();

    const r = await report(w.runId, R2);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const unchecked = [
      { issueKey: await keyOf(unmarked), commit: null, why: 'its merge names no commit' },
      {
        issueKey: await keyOf(w.later),
        commit: LATER,
        why: 'nobody read its ancestry: no box holding the checkout answered',
      },
    ];
    expect(r.body.unchecked).toEqual(unchecked);
    const batch = await call('GET', `/release-batches/${w.runId}`);
    expect(batch.body.rangeUnchecked).toEqual(unchecked);
  });

  it('refuses the later landing as head even where nothing else is read: the head is that landing', async () => {
    const w = await world();
    ancestry.silent = 'no box holding the checkout answered';

    const r = await report(w.runId, LATER);

    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain(`${await keyOf(w.later)} (landed at a939c3f)`);
  });
});

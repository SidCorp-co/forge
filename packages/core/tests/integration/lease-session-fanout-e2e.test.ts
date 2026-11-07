/**
 * ISS-1104: every pane on a box leases as one holder id, so two panes each holding one issue read
 * `shared` on both ("not evidence that a run is on this one"). Where the lease names its holder's
 * session, the fanout is counted per holder and session; a lease naming none is counted under its
 * holder alone, as before. Against real Postgres, through the fanout the sweeps and the board read.
 *
 * @direct-test-of packages/core/src/issues/lease-fanout.ts
 * @direct-test-of packages/core/src/issues/session-claim.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { holderFanout, readClaim } from '../../src/issues/lease-fanout.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const HOLDER = 'forge-master-sid-xeon-1';

let projectId: string;
let ownerId: string;
let seq = 0;

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
});

/** An `in_progress` issue under a live lease of {@link HOLDER}, naming `session` where given. */
async function leasedBy(session?: string): Promise<Record<string, unknown>> {
  seq += 1;
  const { id } = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(Date.now() - 3_600_000),
  });
  const lease = {
    holder: HOLDER,
    renewedAt: new Date().toISOString(),
    minutes: 60,
    ...(session === undefined ? {} : { session }),
  };
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease) VALUES (${id}, ${JSON.stringify(lease)}::jsonb)
  `);
  return lease;
}

async function read(leases: Record<string, unknown>[]) {
  const now = new Date();
  const fanout = await holderFanout(leases, now);
  return leases.map((l) => readClaim(l, now, fanout));
}

describe('the fanout of a box holder whose panes name their sessions', () => {
  it('reads each pane holding one issue as live, naming its session', async () => {
    const leases = [await leasedBy('pane-a'), await leasedBy('pane-b')];

    const [a, b] = await read(leases);

    expect(a).toMatchObject({ verdict: 'live', session: 'pane-a', fanout: 1 });
    expect(b).toMatchObject({ verdict: 'live', session: 'pane-b', fanout: 1 });
  });

  it('reads one session holding two issues as shared', async () => {
    const leases = [await leasedBy('pane-a'), await leasedBy('pane-a'), await leasedBy('pane-b')];

    const [a1, a2, b] = await read(leases);

    expect(a1).toMatchObject({ verdict: 'shared', fanout: 2 });
    expect(a2).toMatchObject({ verdict: 'shared', fanout: 2 });
    expect(b).toMatchObject({ verdict: 'live', fanout: 1 });
  });

  it('counts leases naming no session under the holder alone, as before', async () => {
    const leases = [await leasedBy(), await leasedBy(), await leasedBy('pane-a')];

    const [bare1, bare2, named] = await read(leases);

    expect(bare1).toMatchObject({ verdict: 'shared', fanout: 2, session: null });
    expect(bare2).toMatchObject({ verdict: 'shared', fanout: 2 });
    expect(named).toMatchObject({ verdict: 'live', fanout: 1 });
  });
});

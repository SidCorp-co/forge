/**
 * A step that names a contract is outdated only where the contract has a newer breaking version than
 * the one the latest baseline of a requirement linked to the design pins (REQ-17 BC-5, ISS-580 c3),
 * and the marker names the contract and both versions. A newer version that breaks nothing marks
 * nothing, and neither does a breaking one the latest baseline already pins.
 *
 * @direct-test-of packages/core/src/workflows/health-inputs.ts
 * @direct-test-of packages/core/src/workflows/health-markers.ts
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  seedContractVersion,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let slug: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(ownerId);
  projectId = project.id;
  slug = project.slug;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;

/** A contract version recorded strictly after the one before it, so "newer" is never a tie. */
async function version(
  v: string,
  classification: 'initial' | 'non-breaking' | 'breaking',
): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
  await seedContractVersion({
    providerId: projectId,
    ref: `${slug}/api`,
    version: v,
    classification,
  });
}

async function approvedDesign(): Promise<string> {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = 'contracted';
  d.steps[0].node.contracts = [{ provider: slug, slug: 'api' }];
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: d }),
    201,
  );
  const id = made.document.id as string;
  ok(await say('master', 'POST', at(`/workflows/${id}/design/propose`), { revision: 1 }));
  ok(
    await say('owner', 'POST', at(`/workflows/${id}/design/decision`), {
      revision: 1,
      decision: 'approve',
    }),
  );
  return id;
}

/** A requirement linked to the design and the contract, agreed: its baseline pins the version current now. */
async function agreedRequirement(workflowId: string): Promise<string> {
  const created = ok(
    await say('owner', 'POST', at('/requirements'), {
      title: 'Discharge follow-up',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the follow-up' }],
    }),
    201,
  );
  const key = String(created.key);
  ok(await say('owner', 'POST', at(`/requirements/${key}/workflows`), { workflowId }));
  // the link route asks the project's interface to name the contract; the interface is not what this
  // rule reads, so the link is planted as the route would write it
  await db.execute(sql`
    INSERT INTO requirement_contracts (requirement_id, provider_project_id, contract_slug, linked_by)
    SELECT id, ${projectId}, 'api', ${ownerId} FROM requirements
     WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  ok(await say('owner', 'POST', at(`/requirements/${key}/revisions/1/accept`), {}));
  ok(
    await say('owner', 'POST', at(`/requirements/${key}/agree`), {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

const contractMarkers = async (workflowId: string): Promise<Doc[]> =>
  ok(await say('owner', 'GET', at(`/workflows/${workflowId}/health`))).health.markers.filter(
    (m: Doc) => m.rule === 'outdated.contract_breaking',
  );

describe('a step naming a contract against the version its requirement pins', () => {
  it('is outdated only past a newer breaking version, and the marker names both versions', async () => {
    await version('1.0.0', 'initial');
    const workflowId = await approvedDesign();
    const key = await agreedRequirement(workflowId);
    expect(await contractMarkers(workflowId), 'the pinned version is the newest').toEqual([]);

    await version('1.1.0', 'non-breaking');
    expect(await contractMarkers(workflowId), 'a newer version that breaks nothing').toEqual([]);

    await version('2.0.0', 'breaking');
    const [marker, ...more] = await contractMarkers(workflowId);
    expect(more, 'one marker, on the one step naming the contract').toEqual([]);
    expect(marker).toMatchObject({
      kind: 'outdated',
      target: { kind: 'step', step: 'his', layer: 'planned' },
      says: {
        reason: {
          key: 'workflows.marker.contractBreaking',
          vars: { contract: `${slug}/api`, v: '2.0.0', pinned: '1.0.0' },
        },
      },
      source: { type: 'contract_version', key: `${slug}/api@2.0.0` },
    });
    expect(marker?.reason).toContain('2.0.0');
    expect(marker?.reason).toContain('1.0.0');

    // the requirement's latest baseline moves onto 2.0.0: nothing newer breaks, nothing is outdated
    ok(
      await say('owner', 'POST', at(`/requirements/${key}/repin`), {
        revision: 1,
        reason: 'Re-pinned onto the breaking contract version for this test.',
      }),
    );
    expect(await contractMarkers(workflowId), 'the latest baseline pins 2.0.0').toEqual([]);
  });
});

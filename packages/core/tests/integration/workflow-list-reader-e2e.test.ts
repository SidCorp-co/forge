/**
 * @direct-test-of packages/core/src/workflows/design-requirements.ts
 * @direct-test-of packages/core/src/workflows/design-service.ts
 *
 * What a first-time reader of a project's workflows reads (ISS-781): each listed design names the
 * requirements linked to it, and a draft waits on one actor under one name, the same on the list
 * and on the design's own page.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const at = (path: string) => `/api/projects/${projectId}${path}`;

const design = (flow: string): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  return d;
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
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

const listed = async () =>
  new Map(
    (ok(await say('owner', 'GET', at('/workflows'))).workflows as Doc[]).map((r) => [
      r.document.flow as string,
      r,
    ]),
  );

describe('the workflows list a first-time reader opens', () => {
  it('names each design its linked requirements, in key order, and none where none links', async () => {
    for (const flow of ['intake', 'billing', 'alone']) {
      ok(
        await say('master', 'POST', at('/workflows'), {
          baseRevision: null,
          document: design(flow),
        }),
        201,
      );
    }
    const keys: string[] = [];
    for (const designs of [['intake'], ['intake', 'billing']]) {
      const made = ok(
        await say('owner', 'POST', at('/requirements'), {
          title: `Requirement over ${designs.join(' and ')}`,
          reason: 'the reader sees what each design delivers',
          criteria: [{ body: 'A patient is discharged with a follow-up booked.' }],
          designs,
        }),
        201,
      );
      keys.push(made.key as string);
    }
    const rows = await listed();
    expect(rows.get('intake')?.requirements).toEqual(keys);
    expect(rows.get('billing')?.requirements).toEqual([keys[1]]);
    expect(rows.get('alone')?.requirements).toEqual([]);
  });

  it('names the actor a draft waits on the same way on the list and on its page', async () => {
    const row = (await listed()).get('alone') as Doc;
    expect(row.design.status).toBe('draft');
    expect(row.design.waitingOn.kind).toBe('agent');
    const page = ok(await say('owner', 'GET', at(`/workflows/${row.workflowId}/design`)));
    expect(page.waitingOn.who).not.toBe('Master');
    expect(page.waitingOn.who).toBe(row.design.waitingOn.who);
    expect(page.waitingOn.says.who).toEqual(row.design.waitingOn.says.who);
  });
});

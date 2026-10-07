// A design revision proposed and waiting on a person who may decide it is a Workflows row of that
// person's Needs you, through the real read (readNeedsYou over designHealthOf), and on no one else's.
// ISS-330 shipped the row with only designRowOf under unit test, and the Dashboard counted a row it
// did not draw; this is the end-to-end the read had no test for.

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
let ownerId: string;
let memberId: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let readNeedsYou: typeof import('../../src/development/needs-you.js').readNeedsYou;

const at = (path: string) => `/api/projects/${projectId}${path}`;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ({ readNeedsYou } = await import('../../src/development/needs-you.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({ permissions: ['*'], userId: agent, name: 'master', projectIds: [projectId] })
    ).plaintext,
  });
}, 120_000);

afterAll(closeWorld);

describe('readNeedsYou with a proposed design revision', () => {
  it('returns the Workflows row, naming the revision, for the viewer who may decide it', async () => {
    const d: Doc = JSON.parse(
      readFileSync(
        new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
        'utf8',
      ),
    );
    d.project = projectId;
    d.flow = 'needs-you-flow';
    const made = ok(
      await say('master', 'POST', at('/workflows'), { baseRevision: null, document: d }),
      201,
    );
    ok(
      await say('master', 'POST', at(`/workflows/${made.document.id}/design/propose`), {
        revision: 1,
      }),
    );

    const owner = await readNeedsYou(projectId, {
      userId: ownerId,
      agency: 'human',
      isAdmin: true,
      mayApprove: true,
    });
    const rows = owner.items.filter((i) => i.area === 'designs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'workflow',
      key: 'needs-you-flow',
      waitingOn: { kind: 'you', act: 'approve or return revision 1' },
    });
    expect(rows[0]?.title).toMatch(/ · revision 1 proposed$/);
    expect(owner.areas.designs.you).toBe(1);
    // the count of every area is the count of its rows: nothing counted is undrawn
    for (const [area, read] of Object.entries(owner.areas)) {
      expect(owner.items.filter((i) => i.area === area)).toHaveLength(read.you);
    }

    const member = await readNeedsYou(projectId, {
      userId: memberId,
      agency: 'human',
      isAdmin: false,
      mayApprove: false,
    });
    expect(member.items.filter((i) => i.area === 'designs')).toHaveLength(0);
  });
});

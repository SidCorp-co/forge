/**
 * ISS-1232 (FB-632): a draft release waited on the project's master to cut it and read
 * `can.cut: false` to that master, from the bare project.admin grant, which the cut door
 * (`release-batch/cut-as.ts:requireReleaseActAs`) does not ask of a master outside strict (REQ-79 r6
 * BC-17); and its rule named no door, so the master guessed a cut route of the release's own (404).
 * The read and the door now meet one rule. Over REST, against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/cut-as.ts
 * @direct-test-of packages/core/src/release-batch/version-routes.ts
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backgroundRefreshesSettled } from '../../src/release-page/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { declareControls } from '../helpers/project-controls.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
const tokens: Record<'member' | 'master', string> = { member: '', master: '' };

const fx = releaseWorld(() => ({ projectId, ownerId }));
let unplant: (() => void) | null = null;

afterEach(async () => {
  unplant?.();
  await backgroundRefreshesSettled();
});

beforeEach(async () => {
  unplant = plantLiveBuild('e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510');
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  // a person and the project's master, holding the same role and no project.admin of their own
  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  tokens.member = await userToken(member.id);
  const masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  tokens.master = await patToken(masterId, [projectId], 'master');
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'source' });
});

const call = (who: keyof typeof tokens, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(tokens[who], method, `/api/projects/${projectId}${path}`, body);

const detail = async (who: keyof typeof tokens) => {
  const r = await call(who, 'GET', '/releases/0.1.0');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as { can: { cut: boolean }; waitingOn: Record<string, unknown> };
};

const landed = () =>
  fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A new thing' });

describe("the master's cut, read as the cut door reads it", () => {
  it('offers the cut to the master it waits on, naming the door, and the door takes it', async () => {
    const id = await landed();
    expect(await detail('master')).toMatchObject({
      attentionGroup: 'waiting',
      waitingOn: {
        kind: 'agent',
        who: 'Master',
        act: 'cut 0.1.0',
        rule: expect.stringContaining(`with POST /api/projects/${projectId}/release-batches`),
      },
      can: { cut: true, decide: false },
    });
    const cut = await call('master', 'POST', '/release-batches', { issueIds: [id] });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  });

  it('reads it false to a person holding the same role, and to the master on a strict project', async () => {
    const id = await landed();
    expect((await detail('member')).can.cut).toBe(false);
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    expect((await detail('master')).can.cut).toBe(false);
    const cut = await call('master', 'POST', '/release-batches', { issueIds: [id] });
    expect(cut.status, JSON.stringify(cut.body)).toBe(403);
  });
});

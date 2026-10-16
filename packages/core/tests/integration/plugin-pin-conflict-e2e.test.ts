/**
 * REQ-26: a project pins the plugin version its runs use, and a box serving several projects reports
 * a conflicting pin instead of silently picking one. A box holds ONE clone of each marketplace
 * (`runner-workspace/src/plugin_sync.rs:ensure_plugins`), so two different commits pinned into one
 * marketplace by the projects one box serves is a conflict, whether they pin the same plugin or two
 * plugins of it. The box reads it on `GET /api/devices/me/plugins`; each project involved reads it on
 * `GET /api/projects/:id/plugin-conflicts`.
 */
// @direct-test-of packages/core/src/lib/plugin-designation.ts
// @direct-test-of packages/core/src/devices/plugin-conflicts.ts

import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api, userToken } from '../helpers/api.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  type TestProject,
  truncateAll,
} from '../helpers/factories.js';

const MARKET = 'SidCorp-co/forge-plugin';
const OTHER_MARKET = 'SidCorp-co/codemap';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface Served {
  marketplace: string;
  name: string;
  pinnedRef: string | null;
  projects: string[];
  pinnedRefConflict?: string[];
}

interface Conflict {
  device: { id: string; name: string };
  marketplace: string;
  pins: { project: string; name: string; ref: string }[];
}

const pin = (name: string, ref: string | null, marketplace = MARKET) => ({
  marketplace,
  name,
  pinnedRef: ref,
});

describe('a box serving several projects that pin one marketplace', () => {
  let ownerId: string;
  let ownerToken: string;
  let deviceId: string;
  let boxToken: string;

  beforeEach(async () => {
    await truncateAll();
    ownerId = (await createTestUser({ verified: true })).id;
    ownerToken = await userToken(ownerId);
    deviceId = await createTestDevice(ownerId, { name: 'shared-box' });
    boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId }))
      .plaintext;
  });

  async function onBox(plugins: unknown[], box = deviceId): Promise<TestProject> {
    const p = await createTestProject(ownerId, { agentConfig: { plugins } });
    await bindTestRunner(p.id, box);
    return p;
  }

  async function served(token = boxToken): Promise<Served[]> {
    const res = await api(token, 'GET', '/api/devices/me/plugins');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as { plugins: Served[] }).plugins;
  }

  async function conflictsOf(project: TestProject): Promise<Conflict[]> {
    const res = await api(ownerToken, 'GET', `/api/projects/${project.id}/plugin-conflicts`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as { conflicts: Conflict[] }).conflicts;
  }

  it('serves a project its own pin when nothing else on the box pins that marketplace', async () => {
    const p = await onBox([pin('forge', A)]);

    expect(await served()).toEqual([
      { marketplace: MARKET, name: 'forge', pinnedRef: A, projects: [p.slug] },
    ]);
    expect(await conflictsOf(p)).toEqual([]);
  });

  it('two projects pinning one plugin at different commits: the box gets no pin and the conflict, and each project reads who pins what', async () => {
    const p = await onBox([pin('forge', A)]);
    const q = await onBox([pin('forge', B)]);

    const [entry] = await served();
    expect(entry).toMatchObject({ name: 'forge', pinnedRef: null, pinnedRefConflict: [A, B] });
    expect(entry?.projects).toEqual([p.slug, q.slug].sort());

    const expected: Conflict[] = [
      {
        device: { id: deviceId, name: 'shared-box' },
        marketplace: MARKET,
        pins: [
          { project: p.slug, name: 'forge', ref: A },
          { project: q.slug, name: 'forge', ref: B },
        ].sort((x, y) => x.project.localeCompare(y.project)),
      },
    ];
    expect(await conflictsOf(p)).toEqual(expected);
    expect(await conflictsOf(q)).toEqual(expected);
  });

  it('two projects pinning two plugins of one marketplace at different commits are a conflict too: the box holds one clone', async () => {
    const p = await onBox([pin('forge', A)]);
    const q = await onBox([pin('forge-codemap', B)]);

    const list = await served();
    expect(list.map((e) => [e.name, e.pinnedRef, e.pinnedRefConflict])).toEqual([
      ['forge', null, [A, B]],
      ['forge-codemap', null, [A, B]],
    ]);

    const [c] = await conflictsOf(q);
    expect(c?.marketplace).toBe(MARKET);
    expect(c?.pins).toEqual(
      [
        { project: p.slug, name: 'forge', ref: A },
        { project: q.slug, name: 'forge-codemap', ref: B },
      ].sort((x, y) => x.project.localeCompare(y.project)),
    );
  });

  it('the same commit pinned by both, or a pin beside an unpinned designation, is no conflict', async () => {
    const p = await onBox([pin('forge', A)]);
    const q = await onBox([pin('forge', A), pin('forge-codemap', null)]);
    await onBox([pin('forge', null)]);

    expect((await served()).map((e) => [e.name, e.pinnedRef, e.pinnedRefConflict])).toEqual([
      ['forge', A, undefined],
      ['forge-codemap', null, undefined],
    ]);
    expect(await conflictsOf(p)).toEqual([]);
    expect(await conflictsOf(q)).toEqual([]);
  });

  it('different commits in two marketplaces are no conflict', async () => {
    await onBox([pin('forge', A)]);
    const q = await onBox([pin('forge-codemap', B, OTHER_MARKET)]);

    expect((await served()).map((e) => [e.marketplace, e.pinnedRef])).toEqual([
      [OTHER_MARKET, B],
      [MARKET, A],
    ]);
    expect(await conflictsOf(q)).toEqual([]);
  });

  it('different commits on two boxes are no conflict, and a project on two boxes reads only the box that conflicts', async () => {
    const otherBox = await createTestDevice(ownerId, { name: 'other-box' });
    const otherToken = (
      await mintPat({ permissions: ['*'], userId: ownerId, name: 'box2', deviceId: otherBox })
    ).plaintext;
    const p = await onBox([pin('forge', A)]);
    await bindTestRunner(p.id, otherBox);
    await onBox([pin('forge', B)]);

    expect((await served(otherToken)).map((e) => e.pinnedRef)).toEqual([A]);
    expect((await conflictsOf(p)).map((c) => c.device.name)).toEqual(['shared-box']);
  });

  it('a project on the box whose stored list no write door accepts is refused by name on both reads, never read as no conflict', async () => {
    const p = await onBox([pin('forge', A)]);
    await onBox([{ marketplace: MARKET, name: 'Not Kebab', pinnedRef: B }]);

    const box = await api(boxToken, 'GET', '/api/devices/me/plugins');
    expect(box.status).toBe(422);
    expect(JSON.stringify(box.body)).toContain('PLUGIN_DESIGNATIONS_INVALID');

    const read = await api(ownerToken, 'GET', `/api/projects/${p.id}/plugin-conflicts`);
    expect(read.status).toBe(422);
    expect(JSON.stringify(read.body)).toContain('PLUGIN_DESIGNATIONS_INVALID');
  });
});

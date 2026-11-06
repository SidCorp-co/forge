/**
 * ISS-1009 (FB-516, FB-517, FB-537, FB-539): a room's release read says what holds a release not yet
 * shipped. sidpeak's rooms read only a draft's version, state and issue count, so the agent tried to
 * approve an uncut draft (refused: not cut) and then asked Forge to cut it, while the draft waited on
 * sidpeak's master. Here the read carries, from the release page's own answer, whose act a draft
 * waits on and since when, the approval it owes and who may give it, each issue not ready and why,
 * and the next step; it never claims nothing is happening, and a project out of the room's scope is
 * refused by name.
 *
 * @direct-test-of packages/core/src/support/ops-reads.ts
 * @direct-test-of packages/core/src/support/ops-release-holds.ts
 * @direct-test-of packages/core/src/support/prompt.ts
 * @direct-test-of packages/core/src/release-batch/carrying-release.ts
 * @direct-test-of packages/core/src/steward/release-ask.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { holderNames } from '../../src/permissions/index.js';
import { releasesRead } from '../../src/support/ops-reads.js';
import type { RoomRow } from '../../src/support/store.js';
import '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { declareControls } from '../helpers/project-controls.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let slug: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

/** An operations room scoped to the project, as a room's read runs. */
const room = () =>
  ({
    id: randomUUID(),
    projectId,
    kind: 'operations',
    scope: 'project',
    bindingId: randomUUID(),
  }) as unknown as RoomRow;

interface HeldRelease {
  version: string;
  state: string;
  holds?: {
    waitsOn: string;
    owes: string;
    says: string;
    since: string;
    waited: string;
    approval: string;
    notReady: { issue: string; title: string; why: string }[];
    next: string;
  };
}

async function read(): Promise<{ releases: HeldRelease[]; unseen?: string }> {
  const out = await releasesRead(room(), slug);
  if (!out.ok) throw new Error(JSON.stringify(out.refusals));
  return out.value as { releases: HeldRelease[]; unseen?: string };
}

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const [p] = [...(await db.execute(sql`SELECT slug FROM projects WHERE id = ${projectId}`))] as {
    slug: string;
  }[];
  slug = String(p?.slug);
  // the project's master: an agent member writing it from a box it is paired on
  const masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  await pairTestBox(projectId, { pairedBy: masterId, actsAs: masterId });
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

describe("a room's release read says what holds a draft (sidpeak 0.22.0, FB-537)", () => {
  it("a draft waiting on its cut waits on the project's master, since when and for how long", async () => {
    await fx.insertIssue('awaiting_release', {
      section: 'Added',
      title: 'Visit reminders',
      userFacing: 'A reminder reaches the nurse.',
    });
    const { releases, unseen } = await read();
    const draft = releases.find((r) => r.state === 'draft');
    expect(draft?.holds?.says).toMatch(
      /^waits on the project's master to cut 0\.1\.0, since \d{4}-\d\d-\d\dT[\d:.]+Z \(\d+ minutes?\)$/,
    );
    expect(draft?.holds?.notReady).toEqual([]);
    expect(draft?.holds?.next).toContain("route it to the project's master");
    // never claims nothing is happening: what Forge cannot read is said by name
    expect(unseen).toContain('does not mean nothing is happening');
  });

  it('a draft carrying an issue not ready names it and why', async () => {
    const id = await fx.insertIssue(
      'awaiting_release',
      { section: 'Added', title: 'Visit reports', userFacing: 'Reports keep their filter.' },
      true,
      ['The filter stays after a reload.'],
    );
    const [row] = [...(await db.execute(sql`SELECT iss_seq FROM issues WHERE id = ${id}`))] as {
      iss_seq: number;
    }[];
    const { releases } = await read();
    const draft = releases.find((r) => r.state === 'draft');
    expect(draft?.holds?.notReady).toEqual([
      expect.objectContaining({
        issue: `ISS-${row?.iss_seq}`,
        why: expect.stringContaining('not all judged yet'),
      }),
    ]);
  });

  it("under strict the cut is its admins', named, never the master's", async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    await fx.insertIssue('awaiting_release', {
      section: 'Added',
      title: 'Visit reminders',
      userFacing: 'A reminder reaches the nurse.',
    });
    const admins = (await holderNames('project.admin', projectId)).join(', ');
    const draft = (await read()).releases.find((r) => r.state === 'draft');
    expect(draft?.holds?.waitsOn).toBe(admins);
    expect(draft?.holds?.says).toContain(`waits on ${admins} to cut 0.1.0`);
    expect(draft?.holds?.approval).toContain('owed once it is cut');
  });

  it("a project out of the room's scope is refused by name, never an empty list", async () => {
    const out = await releasesRead(room(), 'not-a-project-here');
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain('OPS_OUT_OF_SCOPE');
    expect(JSON.stringify(out)).toContain('not-a-project-here');
  });
});

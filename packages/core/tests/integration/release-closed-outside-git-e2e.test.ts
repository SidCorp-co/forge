/**
 * ISS-1129 (agenfold ISS-272, FB-576): work done live as config, no code. Its mark named a `landing`
 * and `artifacts` (surface `config`) and no commit, it was closed met in scope, and its criteria's
 * verdicts were recorded. It then sat on draft 0.211.0 for good, held RELEASE_CRITERIA_UNEARNED with a
 * remedy (`DELETE` the mark) that a closed issue refuses.
 *
 * A closed issue whose mark names artifacts and no commit shipped on its own record: no release can
 * carry a change that is in no commit, so it waits for none, as a design-only or adoption-only close
 * waits for none. One at `awaiting_release` still waits, and a closed issue whose mark claims a
 * commit still rides the next release. No gate reason offers a `DELETE` of the mark on a closed issue.
 * Against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/waiting-for-release.ts
 * @direct-test-of packages/core/src/release-batch/landed-build.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 */

import { ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { draftReleaseIssueIds } from '../../src/release-batch/index.js';
import { landedBuildsOf } from '../../src/release-batch/landed-build.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import {
  declareProductionDocument,
  fakeCoolify,
  releaseWorld,
  verdictComment,
} from '../helpers/release-world.js';

/** be56fb5, what production ran when the verdicts were recorded. */
const PRODUCTION_RAN = 'be56fb5000000000000000000000000000000b56';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const CONFIG = [{ surface: 'config', ref: 'agent routing settings', change: 'changed' }];

let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));

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
  await declareControls(projectId, ownerId, { delivery: { verdictsRequired: true } });
  const bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  // work lands on `main` and production deploys `production` through a promotion: criteria are
  // earned at the landing (`criteria-basis.ts`), the basis ISS-272's hold was written on
  await declareProductionDocument({
    projectId,
    ownerId,
    bindingId,
    trigger: 'on-land',
    deploysFrom: 'production',
  });
  await fx.seedReleaseRunner();
});

/** Closed met in scope by its holder: the `awaiting_release` -> `closed` edge on today's machine. */
async function closeInScope(id: string): Promise<void> {
  await seedIssueStatus(id, 'closed');
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, machine_version,
                                    actor_type, actor_agency, actor_id, source)
    VALUES ('issue', ${id}, 'awaiting_release', 'closed', ${ISSUE_MACHINE.shapes.length},
            'user', 'agent', ${ownerId}, 'test')
  `);
}

/** ISS-272's shape: three criteria, each passed at what production ran, marked outside git. */
async function configDoneLive(): Promise<string> {
  const id = await fx.insertIssue('awaiting_release', undefined, true, ['one', 'two', 'three']);
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = NULL, merged_paths = NULL,
                      merged_landing = 'surface config, set live on the production console',
                      merged_artifacts = ${JSON.stringify(CONFIG)}::jsonb
     WHERE id = ${id}
  `);
  const block = (n: number) =>
    [`criterion: ${n}`, 'verdict: pass', `commit: ${PRODUCTION_RAN}`, 'evidence: judge.txt'].join(
      '\n',
    );
  await fx.postVerdict(id, verdictComment([block(1), block(2), block(3)]), 'judge.txt');
  return id;
}

describe('a closed issue marked outside git waits for no release (ISS-1129)', () => {
  it('leaves the draft and is held by nothing once closed', async () => {
    const id = await configDoneLive();
    await closeInScope(id);

    expect(await draftReleaseIssueIds(projectId)).not.toContain(id);
    await sweepAutomaticReleases();
    expect(await fx.holdOf(id)).toBeNull();
    expect((await fx.stored(id)).claim).toBeNull();
  });

  it('a hold written before the close is cleared by the next sweep', async () => {
    const id = await configDoneLive();
    await sweepAutomaticReleases();
    // at the gate it still waits: `awaiting_release` asks its holder to close it, or a release
    expect(await draftReleaseIssueIds(projectId)).toContain(id);
    expect((await fx.holdOf(id))?.code).toBe('RELEASE_CRITERIA_UNEARNED');

    await closeInScope(id);
    await sweepAutomaticReleases();
    expect(await fx.holdOf(id)).toBeNull();
    expect(await draftReleaseIssueIds(projectId)).not.toContain(id);
  });

  it('keeps a closed issue whose mark names a commit on the roster', async () => {
    const id = await configDoneLive();
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${PRODUCTION_RAN} WHERE id = ${id}`);
    await closeInScope(id);
    expect(await draftReleaseIssueIds(projectId)).toContain(id);
  });
});

describe('no gate reason offers a DELETE its status refuses (ISS-1129)', () => {
  /** A mark naming nothing, neither commit nor artifacts. */
  async function assertedOnly(status: string): Promise<string> {
    const id = await fx.insertIssue('awaiting_release');
    if (status !== 'awaiting_release') await closeInScope(id);
    return id;
  }

  it('offers the unmark on an issue at the gate, which may take it', async () => {
    const id = await assertedOnly('awaiting_release');
    const build = (await landedBuildsOf([id])).get(id);
    expect(build?.sha).toBeNull();
    expect(build && 'why' in build ? build.why : '').toContain('DELETE');
  });

  it('offers the correction, never the unmark, on a closed issue', async () => {
    const id = await assertedOnly('closed');
    const build = (await landedBuildsOf([id])).get(id);
    const why = build && 'why' in build ? build.why : '';
    expect(why).not.toContain('DELETE');
    expect(why).toContain(`/api/issues/${id}/merge/correction`);
  });

  it('names a mark outside git as such, at the gate and closed', async () => {
    const id = await configDoneLive();
    const atGate = (await landedBuildsOf([id])).get(id);
    const gateWhy = atGate && 'why' in atGate ? atGate.why : '';
    expect(gateWhy).toContain('outside git');
    expect(gateWhy).not.toContain('DELETE');
    await closeInScope(id);
    const closed = (await landedBuildsOf([id])).get(id);
    expect(closed && 'why' in closed ? closed.why : '').not.toContain('DELETE');
  });
});

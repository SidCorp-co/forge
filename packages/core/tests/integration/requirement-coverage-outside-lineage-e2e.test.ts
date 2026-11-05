/**
 * ISS-1018, FB-524 (sidcorp-mail, 2026-11-05) — a requirement counts an issue's verdict judged at a
 * build that carries the issue's landing, though production's commit does not hold it. ISS-8 (cabymail
 * control) merged on the working branch as 286764e; control is not deployed by the release: mta1 runs a
 * build from the working branch, a2fb071, which holds that landing and is not on the lineage production
 * serves (f3afc54 on `master`). Every verdict the master recorded at a2fb071, by commit and by runtime,
 * was accepted, yet REQ-7 read `{ passing: 0, judged: 0 }`, each criterion "not judged", and the
 * steward kept asking to judge BC-1..BC-6 again: coverage weighed an issue's verdict on the live build
 * alone. It now weighs it at its issue's landing too, by the landing weighing its release reads
 * (`release-batch/landed-build-holds.ts:holdsOnBuilds`), and where neither counts it, it says why on
 * both and names the identity that would.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/requirements/standing-facts.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/core/src/requirements/standing-coverage.ts
 * @direct-test-of packages/core/src/requirements/standing-proof.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, requirementRead, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  landedIssue,
  laterLanding,
  seedLandedWorld,
  verdict,
  world,
} from '../helpers/landed-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** ISS-8's landing on the working branch, mta1's build holding it, and what production serves. */
const LANDING = '286764e1a2b3c4d5e6f708192a3b4c5d6e7f8091';
const CONTROL = 'a2fb0710b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const SERVED = 'f3afc54c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a';
/** A build nothing Forge recorded places after the landing. */
const UNRELATED = '9e4859e00112233445566778899aabbccddeeff0';
const PRODUCTION_PROBE = 'https://mail.example.test/build-info';

const BCS = ['A mailbox is created', 'A mailbox is suspended', 'A quota is enforced'];

/** sidcorp-mail's shape: work lands on the working branch, production deploys `master`, no promotion. */
async function productionOnMaster(): Promise<void> {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: {
        repository: 'github.com/acme/sidcorp-mail',
        defaultBranch: BRANCH,
        branches: [BRANCH, 'master'],
      },
    } as never,
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'master',
        deployment: { mode: 'external' },
        url: 'https://mail.example.test',
        verification: {
          runtime: [
            {
              type: 'http' as const,
              url: PRODUCTION_PROBE,
              path: 'commit',
              identifies: 'source' as const,
            },
          ],
        },
      },
    } as never,
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** The source host's kept answer that production's commit does not carry `judged`. */
async function notServed(judged: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO served_ancestry (project_id, served_commit, judged_commit, carried, differs_in)
    VALUES (${world.projectId}, ${SERVED}, ${judged}, false, ARRAY['control/']::text[])
  `);
}

/** A pass on criterion `n` judged on the runtime `ref`, as `--runtime` records it. */
async function runtimePass(issueId: string, n: number, ref: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, runtime_ref,
                                    author_user_id, author_agency, judge)
    SELECT id, ${issueId}, 'pass', ${`held on mta1 at ${ref}`}, 'runtime', ${ref},
           ${world.ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${issueId} AND n = ${n} AND retired_at IS NULL
  `);
}

/** ISS-8: merged at LANDING, traced to BC-1..3, shipped. */
async function shippedIssue(req: string): Promise<string> {
  const issue = await landedIssue(8, LANDING, BCS);
  await traced(req, issue, 8, { 1: 'BC-1', 2: 'BC-2', 3: 'BC-3' });
  return issue;
}

beforeEach(async () => {
  await seedLandedWorld();
  await productionOnMaster();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PRODUCTION_PROBE)) return Response.json({ commit: SERVED });
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a verdict at a build carrying its issue landing counts outside production lineage (ISS-1018)', () => {
  it('counts ISS-8 passes at a2fb071, by commit and by runtime, where Forge recorded it holding the landing', async () => {
    const req = await agreedRequirement(BCS);
    const issue = await shippedIssue(req);
    // a2fb071 is a landing Forge recorded on the working branch after ISS-8's
    await laterLanding(CONTROL);
    await notServed(CONTROL);
    await verdict(issue, 1, 'pass', CONTROL);
    await verdict(issue, 2, 'pass', CONTROL);
    await runtimePass(issue, 3, CONTROL);
    await seedIssueStatus(issue, 'closed');

    const read = await requirementRead(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 3, passing: 3, judged: 3 });
    for (const bc of read.standing.coverage) {
      expect(bc.verdict, bc.code).toBe('passing');
      expect(bc.issues[0]?.notCounted, bc.code).toBeNull();
      expect(bc.issues[0]?.identity, bc.code).toContain(
        `which holds landing ${LANDING.slice(0, 12)}`,
      );
    }
    expect(JSON.stringify(read.standing)).not.toContain('standing.act.judgeOn');
  });

  it('names why a pass at an unrelated build counts on neither, and which identity would, instead of asking again', async () => {
    const req = await agreedRequirement(BCS.slice(0, 1));
    const issue = await landedIssue(8, LANDING, BCS.slice(0, 1));
    await traced(req, issue, 8, { 1: 'BC-1' });
    await notServed(UNRELATED);
    await verdict(issue, 1, 'pass', UNRELATED);
    await seedIssueStatus(issue, 'closed');

    const read = await requirementRead(req);
    expect(read.standing.delivery.criteriaCoverage).toEqual({ criteria: 1, passing: 0, judged: 0 });
    const [bc] = read.standing.coverage;
    const why = bc?.issues[0]?.notCounted ?? '';
    // the live build's reason
    expect(why).toContain(`which the live build (${SERVED.slice(0, 12)}) does not hold`);
    // the landing's reason, and the identity that would count there
    expect(why).toContain(`not at its issue's landing ${LANDING.slice(0, 12)}`);
    expect(why).toContain(`no merge mark records a landing at ${UNRELATED.slice(0, 12)}`);
    expect(why).toContain(`judge it again on the live build or at ${LANDING.slice(0, 12)}`);
    expect(bc?.why).toContain(why);
    // the steward is told why, not asked to judge again
    const standing = JSON.stringify(read.standing);
    expect(standing).not.toContain('standing.act.judgeOn"');
    expect(standing).toContain('standing.act.uncounted');
  });
});

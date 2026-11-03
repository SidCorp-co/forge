/**
 * ISS-923 fix forward: the merge mark a beta close needs takes the beta twin project's landing shape,
 * read from its project document once per project per fire. A git twin is marked with the dev issue's
 * merged commit and the branch it lands on (production's `deploysFrom` where a release promotes into
 * it) and never a `landing`, which beta refuses there; a git twin's dev issue with no merged commit is
 * named and sent nothing; a beta project whose shape cannot be read is named and its close stays
 * owed; and a pair the old landing-only mark held at awaiting_release is tried once more, closing
 * without a second mark where beta already holds one (sid-desk ISS-769 and ISS-770, marked by hand).
 * The outside_git mark is `beta-port-e2e.test.ts`'s close test. forge-beta is a stub HTTP server
 * enforcing beta's mark rule (`landingMarkRefusal`). Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/client.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/landing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  fireOnce,
  putBetaSecret,
  type Say,
} from '../helpers/beta-port-harness.js';
import {
  beta,
  betaIssue,
  gitDocument,
  promotedDocument,
  RULING_AT,
  type StubIssue,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let say: Say;
let ownerId = '';
let scheduleId = '';

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  beta.projects = [];
  scheduleId = await betaPortScheduleOn(say, scheduleProjectId);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-url', baseUrl);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-token', TOKEN);
  await writeRuling(scheduleProjectId, RULING_AT);
}, 120_000);

afterAll(async () => {
  await stopBeta();
  await closeWorld();
});

const fire = (id: string) => fireOnce(say, id);

describe('a beta port mark in the twin project landing shape (ISS-923 fix forward)', () => {
  const X = 'b7c393812cd5a0f1e2d3c4b5a6978877665544aa';
  const Y = '0123456789abcdef0123456789abcdef01234567';
  const MERGED_AT = '2026-11-03T07:45:47.000Z';

  /** A dev twin with a beta project of its slug holding `document`, or undeclared where none. */
  async function twinWith(document: Record<string, unknown> | null) {
    const dev = await createTestProject(ownerId);
    const betaId = randomUUID();
    beta.projects.push({ id: betaId, slug: dev.slug });
    if (document) beta.configs.set(betaId, document);
    return { dev, betaId };
  }

  const pairOf = async (betaId: string) =>
    (
      await rows<{
        dev_issue_id: string;
        last_tried_status: string | null;
        beta_reached: string | null;
      }>(
        sql`SELECT dev_issue_id, last_tried_status, beta_reached FROM beta_port_pairs WHERE beta_issue_id = ${betaId}`,
      )
    )[0];

  /** The dev issue of a beta issue's pair, closed with the mark given; its key. */
  async function closeDev(betaIssueId: string, commit: string | null): Promise<string> {
    const pair = await pairOf(betaIssueId);
    const devId = pair?.dev_issue_id as string;
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = ${MERGED_AT}::timestamptz, merged_commit_sha = ${commit}, merged_target = 'dev' WHERE id = ${devId}`,
      ),
    );
    const [dev] = await rows<{ iss_seq: number }>(
      sql`SELECT iss_seq FROM issues WHERE id = ${devId}`,
    );
    return `ISS-${dev?.iss_seq}`;
  }

  it('(a)(c)(d)(e) a git twin is marked with the commit and its landing branch, never a landing; a dev issue with no commit is named and nothing is sent; a held pair already marked on beta closes without a second mark', async () => {
    const git = await twinWith(gitDocument('main'));
    const promoted = await twinWith(promotedDocument('dev', 'master'));
    const undeclared = await twinWith(null);
    const plain = betaIssue(30);
    const noCommit = betaIssue(31);
    const held = betaIssue(32);
    const releaseOnly = betaIssue(33);
    const promotes = betaIssue(34);
    const unreadable = betaIssue(35);
    beta.issues.set(git.betaId, [plain, noCommit, held, releaseOnly]);
    beta.issues.set(promoted.betaId, [promotes]);
    beta.issues.set(undeclared.betaId, [unreadable]);
    await fire(scheduleId);
    for (const b of [plain, noCommit, held, releaseOnly, promotes, unreadable]) {
      expect(await pairOf(b.id), b.displayId).toBeDefined();
    }
    const keys = new Map<string, string>();
    keys.set(plain.id, await closeDev(plain.id, X));
    keys.set(noCommit.id, await closeDev(noCommit.id, null));
    keys.set(held.id, await closeDev(held.id, X));
    keys.set(releaseOnly.id, await closeDev(releaseOnly.id, X));
    keys.set(promotes.id, await closeDev(promotes.id, Y));
    keys.set(unreadable.id, await closeDev(unreadable.id, Y));
    // (e) the old path's record: the close tried, beta stopped at awaiting_release, and the operator
    // has since marked both on beta by hand (sid-desk ISS-769 and ISS-770, 2026-11-03)
    for (const b of [held, releaseOnly]) {
      await rows(
        sql`UPDATE beta_port_pairs SET last_mirrored_status = 'awaiting_release', last_tried_status = 'closed', beta_reached = 'awaiting_release' WHERE beta_issue_id = ${b.id}`,
      );
      b.status = 'awaiting_release';
      b.mergedAt = MERGED_AT;
      b.mergedCommitSha = X;
      beta.marks.set(b.id, { target: 'master', commit: X, note: 'by hand' });
    }
    beta.closeNeedsMark = true;
    beta.closeAfterMark.set(releaseOnly.id, 'CLOSE_ONLY_BY_RELEASE');
    beta.transitions.length = 0;
    beta.refusedMarks.length = 0;
    beta.configReads.clear();
    const handMarks = new Map([held, releaseOnly].map((b) => [b.id, beta.marks.get(b.id)]));

    const settled = await fire(scheduleId);
    const movesOf = (b: StubIssue) =>
      beta.transitions.filter((t) => t.issueId === b.id).map((t) => t.toStatus);

    // (a) the commit and the base branch, no landing; beta takes it, then the close
    expect(beta.refusedMarks).toEqual([]);
    expect(beta.marks.get(plain.id)).toEqual({
      commit: X,
      target: 'main',
      mergedAt: MERGED_AT,
      note: `Worked and shipped on forge-dev as ${keys.get(plain.id)}; beta records its status (owner ruling beta-issues-are-worked-on-dev).`,
    });
    expect(movesOf(plain)).toEqual(['closed', 'closed']);
    expect(plain.status).toBe('closed');
    expect(settled.output).toContain(
      `${git.dev.slug}: ${keys.get(plain.id)}: open → closed (beta ISS-30), its landing recorded as commit ${X.slice(0, 12)} on main`,
    );

    // (c) a release-promoted twin is marked on the branch production deploys from
    expect(beta.marks.get(promotes.id)).toMatchObject({ commit: Y, target: 'master' });
    expect(beta.marks.get(promotes.id)).not.toHaveProperty('landing');
    expect(promotes.status).toBe('closed');

    // (d) no dev commit on a git twin: named, nothing sent, beta held at the nearest status
    expect(beta.marks.has(noCommit.id)).toBe(false);
    expect(settled.output).toContain(
      `BETA_PORT_NO_MERGED_COMMIT: ${keys.get(noCommit.id)} holds no merged commit`,
    );
    expect(noCommit.status).toBe('awaiting_release');
    // an undeclared beta project's shape is named, nothing is sent, and the close stays owed
    expect(beta.marks.has(unreadable.id)).toBe(false);
    expect(settled.output).toContain(
      `${undeclared.dev.slug}: beta landing shape: PEER_FORGE_LANDING_UNDECLARED`,
    );

    // the shape is read once per project per fire, and only where a mark is owed
    expect(beta.configReads.get(git.betaId)).toBe(1);
    expect(beta.configReads.get(promoted.betaId)).toBe(1);

    // (e) held pairs: the one beta marked closes without a second mark; a release-only one stays
    expect(movesOf(held)).toEqual(['closed']);
    expect(held.status).toBe('closed');
    expect(movesOf(releaseOnly)).toEqual(['closed']);
    expect(releaseOnly.status).toBe('awaiting_release');
    for (const b of [held, releaseOnly]) expect(beta.marks.get(b.id)).toBe(handMarks.get(b.id));
    expect(settled.output).toContain('CLOSE_ONLY_BY_RELEASE');
    expect(await pairOf(held.id)).toMatchObject({
      last_tried_status: 'closed',
      beta_reached: 'closed',
    });

    // the next fire tries none of them again but the project whose shape it could not read
    beta.transitions.length = 0;
    const marks = beta.marks.size;
    const again = await fire(scheduleId);
    expect(beta.transitions.map((t) => t.issueId)).toEqual([unreadable.id]);
    expect(beta.marks.size).toBe(marks);
    expect(again.output).toContain('PEER_FORGE_LANDING_UNDECLARED');
    beta.closeNeedsMark = false;
  });
});

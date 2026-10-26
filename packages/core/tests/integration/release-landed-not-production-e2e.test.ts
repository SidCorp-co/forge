/**
 * A landing recorded on a staging branch is not production (owner, 2026-10-26). catalog-api recorded
 * 0.2.0 as landed on `dev`, a project declaring no production environment and requiring a release
 * approval; GET /releases answered `production.serving: "0.2.0"`, both releases `shipped`, waiting on
 * nobody because "the release has ended", and counts `done: 2, needs_you: 0`. The owner read it as
 * nothing owed, when production review and promotion is theirs and had not happened.
 *
 * Driven through the record door and the releases read against real Postgres, on the landed world
 * (`helpers/landed-world.ts`) whose document declares `release/stg` and no production environment.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import {
  BRANCH,
  F4,
  judgedAll,
  landedIssue,
  ok,
  record,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

type Listed = {
  version: string;
  state: string;
  current: boolean;
  landedOn: string | null;
  attentionGroup: string;
  waitingOn: { kind: string; who: string; act: string; rule: string };
};

async function landed(): Promise<string> {
  const issue = await landedIssue(5, F4);
  await judgedAll(issue, F4);
  const res = await record([issue], F4);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.version);
}

async function list(token = world.token) {
  return ok(api(token, 'GET', `/api/projects/${world.projectId}/releases`));
}

describe('a landing on a staging branch, on a project that requires a release approval', () => {
  beforeEach(async () => {
    await seedLandedWorld({ verdictsRequired: false, approvalRequired: true });
  });

  it('reads landed on its branch, production serving nothing, and waits on the approver to promote it', async () => {
    const version = await landed();
    const body = await list();
    const [release] = body.releases as Listed[];

    expect(body.production).toEqual({ ok: true, name: null, url: null, serving: null });
    expect(release).toMatchObject({
      version,
      state: 'landed',
      current: false,
      landedOn: BRANCH,
      waitingOn: {
        kind: 'you',
        who: 'You',
        act: `review ${version} and promote it to production`,
        rule: `it landed on ${BRANCH}, which production does not deploy from, so production does not serve it until a holder of releases.approve reviews it and promotes it`,
      },
    });
    expect(body.counts).toMatchObject({ done: 0 });
  });

  it('names the approvers to a member who cannot promote it', async () => {
    await landed();
    const member = (await createTestUser({ verified: true })).id;
    await addProjectMember(world.projectId, member, 'member');
    const [release] = (await list(await userToken(member))).releases as Listed[];

    expect(release?.attentionGroup).toBe('waiting');
    expect(release?.waitingOn).toMatchObject({ kind: 'person' });
    expect(release?.waitingOn.who).not.toBe('Nobody');
  });

  it("serves nothing in production after a change-request release shipped, as catalog-api's 0.1.0 did", async () => {
    await db.execute(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, metadata, release_version, release_released_at, finished_at)
      VALUES (${world.projectId}, 'system', 'completed',
              ${JSON.stringify({ source: 'release-batch', issueIds: [], changeRequests: [] })}::jsonb,
              '0.1.0', now() - interval '1 hour', now() - interval '1 hour')`);
    expect(await landed()).toBe('0.2.0');
    const body = await list();

    expect((body.production as { serving: unknown }).serving).toBeNull();
    expect((body.releases as Listed[]).map((r) => [r.version, r.state, r.current])).toEqual([
      ['0.2.0', 'landed', false],
      ['0.1.0', 'shipped', false],
    ]);
  });
});

describe('a landing on a project that asks no release approval', () => {
  beforeEach(async () => {
    await seedLandedWorld({ verdictsRequired: false, approvalRequired: false });
  });

  it('reads landed, its landing the delivery, and owes nobody anything', async () => {
    await landed();
    const body = await list();
    const [release] = body.releases as Listed[];

    expect(release).toMatchObject({
      state: 'landed',
      landedOn: BRANCH,
      attentionGroup: 'done',
      waitingOn: {
        kind: 'none',
        rule: `it landed on ${BRANCH}; this project declares no production environment and asks no release approval, so the landing is its delivery`,
      },
    });
    expect((body.production as { serving: unknown }).serving).toBeNull();
  });
});

/**
 * ISS-1281 (FB-709, gwork 0.19.0 with #126, 2026-11-17): right after the promotion request was opened
 * the cut naming it was refused RELEASE_PROMOTION_MISSING, "None is open", because the projection the
 * cut reads is filled by the host's webhooks and had not caught up; a minute later the same body was
 * cut. A cut naming `promotion.request` the projection lacks now reads that request from the host
 * once, through the writer a refresh takes, before anything refuses it, and a refusal says which it
 * was: not on the host, or the host unread and the projection maybe stale. GitLab is planted; against
 * real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/promotion-reread.ts
 * @direct-test-of packages/core/src/release-batch/promotion-named.ts
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 * @direct-test-of packages/core/src/release-batch/promotion-standing.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  call,
  codeOf,
  EXTERNAL,
  HEAD,
  landedIssues,
  PROD,
  promotionRequest,
  rows,
  STG,
  seedPromotionWorld,
  world,
} from '../helpers/promotion-world.js';

const planted = vi.hoisted(() => ({
  bindingId: '',
  /** The merge requests GitLab holds, by iid; any other iid answers 404. */
  onHost: new Map<number, { from: string; into: string; state: string }>(),
  unreadable: false,
  /** Every iid the cut read from GitLab, in order. */
  reads: [] as number[],
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    bindingId: planted.bindingId,
    words: { mergeMethods: ['merge'], changeRequest: 'merge request', sigil: '!' },
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
    readChangeRequest: async (number: number) => {
      planted.reads.push(number);
      if (planted.unreadable) throw new Error('GitLab answered 503 Service Unavailable');
      const held = planted.onHost.get(number);
      if (!held) {
        const { SourceHostCallError } = await import(
          '../../src/integrations/source-host/errors.js'
        );
        throw new SourceHostCallError(404, `GitLab answered 404 for merge request !${number}`);
      }
      return {
        number,
        url: `https://gitlab.com/acme/adminhub-api/-/merge_requests/${number}`,
        title: 'Promote release/stg to production',
        state: held.state,
        draft: false,
        headRef: held.from,
        headSha: HEAD,
        baseRef: held.into,
        baseSha: 'f'.repeat(40),
        updatedAt: new Date().toISOString(),
        body: null,
        mergedAt: null,
        mergeCommitSha: null,
      };
    },
  }),
}));

const cutNaming = (issueIds: string[], request: number) =>
  call('POST', '/release-batches', { issueIds, promotion: { request } });

const runsOpened = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${world.projectId}`,
    )
  )[0]?.n;

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seedPromotionWorld(EXTERNAL);
  planted.bindingId = world.bindingId;
  planted.onHost.clear();
  planted.unreadable = false;
  planted.reads = [];
});

describe('a promotion cut reads the request it names from the host once before refusing it', () => {
  it('cuts on a request open on the host that the projection has not caught up with', async () => {
    const ids = await landedIssues();
    planted.onHost.set(5060, { from: STG, into: PROD, state: 'open' });
    const cut = await cutNaming(ids, 5060);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body).toMatchObject({ changeRequests: [{ number: 5060, label: '!5060' }] });
    expect(planted.reads).toEqual([5060]);
  });

  it('reads nothing from the host for a request the projection already holds', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    const cut = await cutNaming(ids, 5053);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(planted.reads).toEqual([]);
  });

  it('refuses a request the host also lacks, naming it as not on the host, never "none is open"', async () => {
    const ids = await landedIssues();
    const cut = await cutNaming(ids, 5061);
    expect(codeOf(cut.body), JSON.stringify(cut.body)).toBe('RELEASE_PROMOTION_MISSING');
    const said = JSON.stringify(cut.body);
    expect(said).toContain('!5061 is not on the host: acme/adminhub-api holds no change request');
    expect(said.toLowerCase()).not.toContain('none is open');
    expect(planted.reads).toEqual([5061]);
    expect(await runsOpened()).toBe(0);
  });

  it('refuses while the host cannot be read, saying the projection may be stale', async () => {
    const ids = await landedIssues();
    planted.unreadable = true;
    const cut = await cutNaming(ids, 5062);
    expect(codeOf(cut.body), JSON.stringify(cut.body)).toBe('RELEASE_PROMOTION_MISSING');
    const said = JSON.stringify(cut.body);
    expect(said).toContain('!5062 is not in Forge');
    expect(said).toContain('GitLab answered 503 Service Unavailable');
    expect(said).toContain('may be stale');
    expect(said.toLowerCase()).not.toContain('none is open');
    expect(planted.reads).toEqual([5062]);
  });

  it('says what the host answered where another request is held and the named one is not', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    const absent = await cutNaming(ids, 5064);
    expect(codeOf(absent.body), JSON.stringify(absent.body)).toBe(
      'RELEASE_PROMOTION_REQUEST_UNKNOWN',
    );
    expect(JSON.stringify(absent.body)).toContain('!5064 is not on the host');

    planted.onHost.set(5065, { from: STG, into: 'main', state: 'open' });
    const elsewhere = await cutNaming(ids, 5065);
    expect(codeOf(elsewhere.body), JSON.stringify(elsewhere.body)).toBe(
      'RELEASE_PROMOTION_REQUEST_UNKNOWN',
    );
    expect(JSON.stringify(elsewhere.body)).toContain(
      '!5065 was read from the host just now: it is open, from `release/stg` into `main`',
    );
    expect(planted.reads).toEqual([5064, 5065]);
    expect(await runsOpened()).toBe(0);
  });
});

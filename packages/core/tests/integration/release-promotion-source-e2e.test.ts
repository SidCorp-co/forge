/**
 * ISS-1001 round 2, adminhub-api on dev.515: the draft 0.12.0 named !5066 its promotion, an open merge
 * request from `fix/shipresolve-webhook-auth` into `release/production`, not the request carrying
 * `release/stg` there. The draft took any request into the branch production deploys from. A request
 * is the promotion only where it carries the promotion's source into production: from that branch, or
 * from one cut to pin a head the source is recorded holding (adminhub-fe !2055). Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/promotion-standing.ts
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  call,
  codeOf,
  EXTERNAL,
  HEAD,
  LANDED,
  landedIssues,
  promotionRequest,
  seedPromotionWorld,
} from '../helpers/promotion-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    compare: async () => 'diverged',
    readChangeRequestChecks: async () => [],
  }),
}));

const FIX = 'fix/shipresolve-webhook-auth';
const FIX_HEAD = 'f6'.repeat(20);

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
});

const draftPromotion = async () => {
  const read = await call('GET', '/releases/0.1.0');
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const release = read.body.release as {
    state: string;
    promotion: { label: string } | null;
    gates: Array<{ code: string }>;
  };
  expect(release.state).toBe('draft');
  return release;
};

describe('a draft names as its promotion only a request carrying its source into production', () => {
  it('never names an open request from a fix branch, the newer number notwithstanding', async () => {
    await landedIssues();
    await promotionRequest(5053, HEAD);
    await promotionRequest(5066, FIX_HEAD, FIX);
    expect((await draftPromotion()).promotion).toMatchObject({ label: '!5053' });
  });

  it('names none where the fix branch is the only request into production, and the cut stands at the missing promotion', async () => {
    const ids = await landedIssues();
    await promotionRequest(5066, FIX_HEAD, FIX);
    const draft = await draftPromotion();
    expect(draft.promotion, 'the !5066 shape').toBeNull();
    expect(draft.gates.map((g) => g.code)).toContain('RELEASE_PROMOTION_MISSING');
    const cut = await call('POST', '/release-batches', {
      issueIds: ids,
      promotion: { request: 5066 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(422);
    expect(codeOf(cut.body)).toBe('RELEASE_PROMOTION_MISSING');
  });

  it('refuses a cut naming the fix branch request beside the promotion, saying which branch it is from', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    await promotionRequest(5066, FIX_HEAD, FIX);
    const cut = await call('POST', '/release-batches', {
      issueIds: ids,
      promotion: { request: 5066 },
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(422);
    expect(codeOf(cut.body)).toBe('RELEASE_PROMOTION_REQUEST_UNKNOWN');
    expect(JSON.stringify(cut.body)).toContain(`from \`${FIX}\``);
    expect(JSON.stringify(cut.body)).toContain("it is not this release's promotion");
    expect(JSON.stringify(cut.body)).toContain('!5053');
  });

  it('still names a request from a branch pinning a head the source holds (adminhub-fe !2055)', async () => {
    await landedIssues();
    await promotionRequest(5066, FIX_HEAD, FIX);
    await promotionRequest(2055, LANDED[1] as string, 'promote/prod-2026-10-29');
    expect((await draftPromotion()).promotion).toMatchObject({ label: '!2055' });
  });
});

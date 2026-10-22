/**
 * ISS-613 (FB-201 point 2, FB-202) — a storefront criterion is often proven over several workflow
 * drafts at once (hop's lead stage over workflows 253, 190 and 100). A `storefront_draft` verdict
 * names every one of them (`workflows`), corroboration reads each, and a move of any one of them
 * takes the verdict off proven: the criteria read answers it superseded, and the release hold names
 * the criterion unearned. The one-workflow form a writer already sends reads as a one-element list.
 * A list that is empty, repeats a workflow, leaves a part without its version, or comes beside the
 * one-workflow fields is refused VERDICT_STOREFRONT_DRAFT_SHAPE at the part that is wrong. Through
 * the app's own routes, against real Postgres; only the provider's draft read is planted.
 *
 * @direct-test-of packages/core/src/issues/criteria/storefront-draft.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/issues/criteria/store.ts
 * @direct-test-of packages/core/src/issues/criteria-verdicts.ts
 * @direct-test-of packages/core/src/issues/standing-facts-read.ts
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontDraftReading } from '../../src/integrations/types.js';
import { unearnedCriteriaReports } from '../../src/issues/criteria-verdicts.js';
import { criteriaOf } from '../../src/issues/standing-facts-read.js';
import { api, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// what the storefront provider holds as each workflow's draft now; a workflow absent reads missing
const held = vi.hoisted(() => new Map<string, StorefrontDraftReading>());

vi.mock('../../src/integrations/storefront-draft-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/storefront-draft-read.js')>()),
  readStorefrontDrafts: async ({ workflowIds }: { workflowIds: readonly string[] }) =>
    new Map(
      workflowIds.map((id): [string, StorefrontDraftReading] => [
        id,
        held.get(id) ?? { kind: 'missing', detail: `the provider holds no workflow \`${id}\`` },
      ]),
    ),
}));

const at = (draftVersion: string): StorefrontDraftReading => ({
  kind: 'read',
  draftVersion,
  workflowCode: 'hop_lead',
});

let projectId: string;
let issueId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  held.clear();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
    source: { type: 'storefront', storefront: { provider: 'autoflow', binding: randomUUID() } },
    extra: { workspace: { isolation: 'remote-draft' } } as never,
  });
  issueId = (
    await createTestIssue(projectId, ownerId, 1, { status: 'open', createdAt: new Date() })
  ).id;
  const criteria = await api(token, 'PUT', `/api/issues/${issueId}/criteria`, {
    criteria: [{ n: 1, statement: 'The lead stage moves a lead from intake to booked' }],
  });
  expect(criteria.status, JSON.stringify(criteria.body)).toBeLessThan(300);
});

const judge = (identity: Record<string, unknown>) =>
  api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'the lead moved intake to booked on beta',
    identity: { kind: 'storefront_draft', environment: 'beta', ...identity },
    evidence: ['https://beta.example.test/leads/intake'],
  });

type Latest = {
  verdict: string;
  identityKind: string | null;
  storefrontDrafts: Array<{ workflowId: string; draftVersion: string }> | null;
  storefrontEnvironment: string | null;
  corroboration: string | null;
  corroborationNote: string | null;
};

async function latest(): Promise<Latest> {
  const r = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const rows = r.body.criteria as Array<{ n: number; latest: Latest | null }>;
  const one = rows.find((c) => c.n === 1)?.latest;
  if (!one) throw new Error(`criterion 1 has no verdict: ${JSON.stringify(r.body)}`);
  return one;
}

/** Criterion 1 as the release hold reads it: null where it is earned, else why not. */
async function hold(): Promise<{ standing: string | null; why: string } | null> {
  const [report] = await unearnedCriteriaReports([issueId], {
    kind: 'undeclared',
    missing: 'a probe',
    route: 'none',
  });
  const one = report?.unearned.find((u) => u.criterion === 1);
  return one ? { standing: one.standing, why: one.why } : null;
}

const refusals = (body: Record<string, unknown>) =>
  (body.error as { refusals?: Array<{ code: string; path: string; detail: string }> })?.refusals ??
  [];

const TWO = [
  { workflowId: '253', draftVersion: 'a1b2c3d4e5' },
  { workflowId: '190', draftVersion: 'f6a7b8c9d0' },
];

describe('a storefront_draft verdict names every workflow draft its criterion rests on', () => {
  it('records both workflows of a two-workflow criterion and returns both', async () => {
    held.set('253', at('a1b2c3d4e5'));
    held.set('190', at('f6a7b8c9d0'));
    const written = await judge({ workflows: TWO });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    const v = await latest();
    expect(v.identityKind).toBe('storefront_draft');
    expect(v.storefrontDrafts).toEqual(TWO);
    expect(v.storefrontEnvironment).toBe('beta');
    expect(v.corroboration).toBe('corroborated');
    expect(await hold()).toBeNull();
  });

  it('takes the verdict off proven when the second workflow draft moves, and back when it returns', async () => {
    held.set('253', at('a1b2c3d4e5'));
    held.set('190', at('f6a7b8c9d0'));
    expect((await judge({ workflows: TWO })).status).toBe(201);

    held.set('190', at('0000ffff99'));
    const moved = await latest();
    expect(moved.corroboration).toBe('superseded');
    expect(moved.corroborationNote).toContain('`190`');
    expect(moved.corroborationNote).toContain('0000ffff99');
    expect(moved.corroborationNote).not.toContain('`253`');
    const held1 = await hold();
    expect(held1?.standing).toBe('superseded');
    const [tally] = await criteriaOf(projectId, [issueId]);
    expect(tally?.stands).toBe(false);

    held.set('190', { kind: 'unreadable', detail: 'the provider timed out' });
    const unread = await latest();
    expect(unread.corroboration).toBe('uncorroborated');
    expect(unread.corroborationNote).toContain('the provider timed out');
    expect((await hold())?.standing).toBe('uncorroborated');

    held.set('190', at('f6a7b8c9d0'));
    expect((await latest()).corroboration).toBe('corroborated');
    expect(await hold()).toBeNull();
    expect((await criteriaOf(projectId, [issueId]))[0]?.stands).toBe(true);
  });

  it('reads the one-workflow form as a one-element list, untouched by another workflow moving', async () => {
    held.set('253', at('a1b2c3d4e5'));
    held.set('190', at('f6a7b8c9d0'));
    const written = await judge({ workflowId: '253', draftVersion: 'a1b2c3d4e5' });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    held.set('190', at('0000ffff99'));
    const v = await latest();
    expect(v.storefrontDrafts).toEqual([{ workflowId: '253', draftVersion: 'a1b2c3d4e5' }]);
    expect(v.corroboration).toBe('corroborated');
  });

  it.each([
    ['an empty list', { workflows: [] }, '/identity/workflows', 'names no workflow'],
    [
      'a repeated workflow',
      { workflows: [TWO[0], { workflowId: '253', draftVersion: 'ffff000011' }] },
      '/identity/workflows/1/workflowId',
      'more than once',
    ],
    [
      'a part with no version',
      { workflows: [TWO[0], { workflowId: '190' }] },
      '/identity/workflows/1/draftVersion',
      'no draftVersion',
    ],
    [
      'both forms at once',
      { workflowId: '253', draftVersion: 'a1b2c3d4e5', workflows: TWO },
      '/identity/workflows',
      'both',
    ],
    ['neither form', {}, '/identity/workflows', 'names no workflow'],
  ])('refuses %s by name, writing nothing', async (_, identity, path, says) => {
    const r = await judge(identity);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const [row] = refusals(r.body);
    expect(row?.code).toBe('VERDICT_STOREFRONT_DRAFT_SHAPE');
    expect(row?.path).toBe(path);
    expect(row?.detail).toContain(says);
    const after = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
    expect((after.body.criteria as Array<{ latest: unknown }>)[0]?.latest).toBeNull();
  });
});

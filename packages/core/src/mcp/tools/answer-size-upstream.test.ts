import { describe, expect, it, vi } from 'vitest';
import { makeFakeContext, makeFakePrincipal } from '../fake-principal.fixture.js';
import { toToolCallContent } from '../tool-result.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ISSUE = '44444444-4444-4444-8444-444444444444';
const WAIT = '77777777-7777-4777-8777-777777777777';

const sentence = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

const wait = (i: number) => ({
  id: WAIT,
  issue: 'ISS-100',
  contract: `provider/api-${i}`,
  provider: { id: PROJECT, slug: 'provider' },
  minVersion: '2.4.0',
  reason: sentence(30, 'reason'),
  settled: i % 2 === 0,
  settledBy: i % 2 === 0 ? '2.4.1' : null,
  settledAt: null,
  current: '2.3.0',
  request: { number: 'HOP-CR-3', requirement: 'REQ-9', requirementStatus: 'draft' },
  createdBy: '33333333-3333-4333-8333-333333333333',
  createdAgency: 'agent' as const,
  createdAt: '2026-10-04T00:00:00.000Z',
  retractedAt: null,
  retractReason: null,
});

const request = (i: number) => ({
  id: WAIT,
  number: `HOP-CR-${i}`,
  direction: 'outgoing' as const,
  contract: 'provider/api',
  consumer: { id: PROJECT, slug: 'consumer' },
  provider: { id: PROJECT, slug: 'provider' },
  requirement: { key: `REQ-${i}`, title: sentence(12, 'title'), status: 'draft' },
  requestedBy: '33333333-3333-4333-8333-333333333333',
  requestedAgency: 'agent' as const,
  createdAt: '2026-10-04T00:00:00.000Z',
});

const criterion = (n: number) => ({
  id: `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`,
  n,
  statement: sentence(40, `statement${n}`),
  position: n,
  requirementCriterionId: null,
  latest: {
    id: WAIT,
    verdict: 'pass',
    reason: sentence(30, 'why'),
    identityKind: 'storefront_draft',
    commitSha: null,
    runtimeRef: null,
    designWorkflowId: null,
    designFlow: null,
    designRevision: null,
    contractRef: null,
    contractVersion: null,
    storefrontWorkflowId: PROJECT,
    storefrontDraftVersion: '12',
    storefrontEnvironment: 'preview',
    corroboration: 'corroborated',
    corroborationNote: sentence(30, 'note'),
    evidence: ['https://example.test/evidence/1'],
    authorAgency: 'agent',
    backfilled: false,
    createdAt: '2026-10-04T00:00:00.000Z',
  },
});

vi.mock('../../project-config/service.js', () => ({
  readProjectDocument: async () => null,
}));

vi.mock('../../ecosystem/waits/read.js', () => ({
  issueContractWaitsOf: async () => ({
    waits: Array.from({ length: 4 }, (_, i) => wait(i)),
    dispatchable: false,
    refusal: { code: 'CONTRACT_WAIT_UNSETTLED', detail: sentence(60, 'detail') },
  }),
}));
vi.mock('../../ecosystem/waits/service.js', () => ({
  addContractWait: async () => ({ ok: true, wait: wait(1), created: true }),
  retractContractWait: async () => ({ ok: true, wait: wait(1) }),
}));
vi.mock('../../ecosystem/requests/read.js', () => ({
  listContractRequests: async () => Array.from({ length: 10 }, (_, i) => request(i)),
}));
vi.mock('../../issues/issue-route-ref.js', () => ({
  resolveIssueRouteRef: async () => ({ id: ISSUE, projectId: PROJECT }),
}));
vi.mock('../../lib/authz.js', () => ({ assertProjectAccess: async () => undefined }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: ISSUE, projectId: PROJECT }] }) }),
    }),
    transaction: async (fn: (tx: object) => unknown) => fn({}),
  },
}));
vi.mock('../../issues/criteria/store.js', () => ({
  listCriteria: async () => Array.from({ length: 12 }, (_, i) => criterion(i + 1)),
  putCriteria: async () => undefined,
  recordVerdict: async () => ({ id: WAIT }),
}));
vi.mock('./lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib.js')>()),
  assertPrincipalIsMember: async () => undefined,
  assertPrincipalIsWriter: async () => undefined,
}));

const { WAIT_HANDLERS } = await import('./ecosystem-contract-waits.js');
const { forgeCriteriaTool } = await import('./forge-criteria.js');

const principal = makeFakePrincipal('tok', '33333333-3333-4333-8333-333333333333', {
  agency: 'agent',
});
const ctx = makeFakeContext(principal);

const KB = 1_024;
const chars = (value: unknown) =>
  (toToolCallContent(value as Record<string, unknown>).content[0] as { text: string }).text.length;

describe('forge_ecosystem contract waits answer what they hold, never a document', () => {
  it('contract_waits answers an issue its few waits, under a few KB', async () => {
    const out = await WAIT_HANDLERS.contract_waits(ctx, PROJECT, { issue: 'ISS-100' });
    expect(chars(out), 'forge_ecosystem contract_waits').toBeLessThan(5 * KB);
  });

  it('contract_requests answers one summary per request, each under 700 characters', async () => {
    const out = await WAIT_HANDLERS.contract_requests(ctx, PROJECT, {});
    const rows = out.requests as unknown[];
    expect(rows).toHaveLength(10);
    expect(chars(out), 'forge_ecosystem contract_requests').toBeLessThan(rows.length * 700);
    expect(JSON.stringify(out)).not.toContain('"criteria"');
  });

  for (const act of ['contract_wait_add', 'contract_wait_retract'] as const) {
    it(`${act} answers the one wait it changed, under 2 KB`, async () => {
      const out = await WAIT_HANDLERS[act](ctx, PROJECT, {
        issue: 'ISS-100',
        wait: WAIT,
        contract: 'provider/api',
        minVersion: '2.4.0',
        reason: 'why',
      });
      expect(out).toHaveProperty('wait');
      expect(chars(out), `forge_ecosystem ${act}`).toBeLessThan(2 * KB);
    });
  }
});

describe('forge_criteria answers the criteria rows and one verdict, never a body', () => {
  const call = async (args: Record<string, unknown>) =>
    forgeCriteriaTool(ctx).handler({ issueId: ISSUE, ...args });

  it('list answers each criterion with its latest verdict, under 2 KB a row', async () => {
    const out = (await call({ action: 'list' })) as { criteria: unknown[] };
    expect(out.criteria).toHaveLength(12);
    expect(chars(out), 'forge_criteria list').toBeLessThan(out.criteria.length * 2 * KB);
  });

  it('a verdict answers the one criterion it judged, under 2 KB', async () => {
    const out = await call({ action: 'verdict', criterion: 3, verdict: 'pass' });
    expect(out).toMatchObject({ verdictId: WAIT, criterion: { n: 3 } });
    expect(chars(out), 'forge_criteria verdict').toBeLessThan(2 * KB);
  });
});

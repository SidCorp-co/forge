import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontDraftReading } from '../integrations/types.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import type { CriterionWithVerdict, LatestVerdict } from './criteria/store.js';

const HOP = 'd180bdca-a927-4b11-b370-fa2ec923dba4';
const JUDGED = 'c12bebe9'.padEnd(64, '0');
const CURRENT = 'dcfd728e'.padEnd(64, '0');

let reading: StorefrontDraftReading = { kind: 'read', draftVersion: CURRENT, workflowCode: 'x' };
let criteria: CriterionWithVerdict[] = [];

vi.mock('./criteria/store.js', () => ({ listCriteria: async () => criteria }));
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: async () => ({
    document: {
      source: { type: 'storefront', storefront: { provider: 'autoflow', binding: 'b-1' } },
    },
  }),
}));
vi.mock('../integrations/store.js', () => ({
  findBindingWithConnectionById: async () => ({ connection: { id: 'conn-1' }, binding: {} }),
  effectiveConfig: () => ({}),
  decryptConnectionSecrets: () => ({}),
}));
vi.mock('../integrations/registry.js', () => ({
  getIntegration: () => ({ storefrontDraft: async () => reading }),
}));

const issueRows = [{ id: 'hop-14', projectId: HOP, acceptanceCriteria: '1. a\n2. b' }];
const selectMock = vi.fn((arg: unknown) => {
  const columns = (arg ?? {}) as Record<string, unknown>;
  const rows = async () =>
    'flow' in columns ? [] : 'id' in columns ? issueRows : [{ name: 'evidence.txt' }];
  const where = vi.fn(rows);
  return { from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })) };
});
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const { unearnedCriteriaReports } = await import('./criteria-verdicts.js');

const NOTHING_SERVED: ServingReading = {
  kind: 'undeclared',
  missing: 'no probe is declared',
  route: 'none',
};

const draft = (n: number, over: Partial<LatestVerdict> = {}): CriterionWithVerdict => ({
  id: `c${n}`,
  n,
  statement: 's',
  position: n,
  requirementCriterionId: null,
  latest: {
    id: `v${n}`,
    verdict: 'pass',
    reason: null,
    identityKind: 'storefront_draft',
    commitSha: null,
    runtimeRef: null,
    designWorkflowId: null,
    designFlow: null,
    designRevision: null,
    contractRef: null,
    contractVersion: null,
    storefrontWorkflowId: '102',
    storefrontDraftVersion: JUDGED,
    storefrontEnvironment: 'preview',
    corroboration: 'corroborated',
    corroborationNote: null,
    evidence: [],
    authorAgency: 'agent',
    backfilled: false,
    createdAt: '2026-10-04T00:00:00.000Z',
    ...over,
  },
});

beforeEach(() => {
  reading = { kind: 'read', draftVersion: CURRENT, workflowCode: 'x' };
  criteria = [draft(1), draft(2)];
});

describe('the release hold on a storefront draft (FB-56)', () => {
  it('holds a verdict stored corroborated once the storefront draft has moved, naming both drafts', async () => {
    const [report] = await unearnedCriteriaReports(['hop-14'], NOTHING_SERVED);
    expect(report?.unearned.map((u) => [u.criterion, u.standing])).toEqual([
      [1, 'superseded'],
      [2, 'superseded'],
    ]);
    expect(report?.unearned[0]?.why).toContain(`no longer holds`);
    expect(report?.unearned[0]?.why).toContain(CURRENT);
  });

  it('earns the verdict while the storefront still holds the draft it judged', async () => {
    reading = { kind: 'read', draftVersion: JUDGED, workflowCode: 'x' };
    const [report] = await unearnedCriteriaReports(['hop-14'], NOTHING_SERVED);
    expect(report?.unearned).toEqual([]);
  });

  it('planted red: an unreadable storefront never earns a draft verdict, unlike an unread runtime', async () => {
    reading = { kind: 'unreadable', detail: 'http_502' };
    const [report] = await unearnedCriteriaReports(['hop-14'], NOTHING_SERVED);
    expect(report?.unearned.map((u) => u.standing)).toEqual(['uncorroborated', 'uncorroborated']);
    expect(report?.unearned[0]?.why).toContain('http_502');
    expect(report?.uncorroborated).toEqual([]);
  });
});

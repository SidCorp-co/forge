import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  waits: [] as Record<string, unknown>[],
  checked: [] as Record<string, unknown>[],
  order: [] as string[],
}));

vi.mock('../issues/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeIssuePrefix: async () => 'CFE',
  heldIssuePrefixes: async () => [],
  isUuid: () => false,
  insertIssueRow: async () => ({ id: 'i1', issSeq: 3 }),
  putCriteria: async () => undefined,
  writeIssueRelations: async () => undefined,
  lockContractsIn: async (_tx: unknown, contracts: { contractSlug: string }[]) => {
    state.order.push(`lock ${contracts.map((c) => c.contractSlug).join(',')}`);
  },
  insertContractWaitIn: async (_tx: unknown, w: Record<string, unknown>) => {
    state.order.push(`insert ${w.contractSlug}`);
    state.waits.push(w);
    return { id: 'w1', settledVersion: null };
  },
}));
vi.mock('../requirements/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rowIn: async () => ({ id: 'r1', reqSeq: 1, status: 'agreed' }),
  linkIssueRefusal: () => null,
  latestBaselineIn: async () => null,
}));
vi.mock('../workflows/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  designNodesIn: async () => null,
  linkBuild: async () => undefined,
  nodeSetRefusals: () => [],
  observedNodesIn: async () => null,
}));
vi.mock('../lib/contract-versions.js', () => ({
  contractVersionReads: () => ({
    waitTargetIn: async (_tx: unknown, t: Record<string, unknown>) => {
      state.checked.push(t);
      if (t.contract !== 'catalog-api/admin-rest-v1') {
        return {
          ok: false,
          refusals: [
            { code: 'CONTRACT_WAIT_CONTRACT_UNKNOWN', path: '/contract', detail: 'unknown' },
          ],
        };
      }
      return {
        ok: true,
        value: {
          contract: t.contract,
          providerProjectId: 'prov-1',
          providerSlug: 'catalog-api',
          contractSlug: 'admin-rest-v1',
          minVersion: t.minVersion,
          dueAt: null,
        },
      };
    },
  }),
}));

const { breakdownEffect, breakdownGuardIn } = await import('./breakdown.js');
const { breakdownWaitTargets } = await import('./rules.js');

const tx = {
  select: () => ({ from: () => ({ where: async () => [{ id: 'bc1', code: 'BC-1' }] }) }),
};
const item = (contractWaits?: unknown) => ({
  title: 'Admin list',
  criteria: [{ body: 'it lists', tracesTo: 'BC-1' }],
  complexity: 's',
  builds: null,
  ...(contractWaits ? { contractWaits } : {}),
});
const payload = (contractWaits?: unknown) => ({ issues: [item(contractWaits)] });
const parse = (p: unknown) => SUGGESTION_PAYLOADS.breakdown.schema.parse(p);

describe('a breakdown item carries its contract waits (requirement-to-delivery breakdown)', () => {
  it('takes contractWaits in the payload', () => {
    const p = SUGGESTION_PAYLOADS.breakdown.schema.safeParse(
      payload([{ contract: 'catalog-api/admin-rest-v1', minVersion: '3.1.0' }]),
    );
    expect(p.success).toBe(true);
  });

  it('refuses at propose by the name the wait door uses, at the wait path', async () => {
    const guard = await breakdownGuardIn(
      tx as never,
      'p1',
      'r1',
      2,
      parse(payload([{ contract: 'catalog-api/nope', minVersion: '3.1.0' }])),
    );
    expect(guard.refusals.map((r) => [r.code, r.path])).toEqual([
      ['CONTRACT_WAIT_CONTRACT_UNKNOWN', '/payload/issues/0/contractWaits/0/contract'],
    ]);
    expect(state.checked.at(-1)).toMatchObject({ projectId: 'p1', minVersion: '3.1.0' });
  });

  it('refuses a second wait of one issue on the same contract', async () => {
    const out = await breakdownWaitTargets(
      parse(
        payload([
          { contract: 'catalog-api/admin-rest-v1', minVersion: '3.1.0' },
          { contract: 'catalog-api/admin-rest-v1', minVersion: '3.2.0' },
        ]),
      ),
      async (w) => ({ ok: true, value: w.minVersion }),
    );
    expect(out.refusals.map((r) => [r.code, r.path])).toEqual([
      ['CONTRACT_WAIT_DUPLICATE', '/payload/issues/0/contractWaits/1/contract'],
    ]);
    expect(out.waits).toEqual([['3.1.0']]);
  });

  it('writes each wait on the filed issue inside the accept, and names it in the effect', async () => {
    state.waits.length = 0;
    const out = await breakdownEffect(
      tx as never,
      'p1',
      {
        id: 's1',
        kind: 'breakdown',
        requirementId: 'r1',
        payload: payload([{ contract: 'catalog-api/admin-rest-v1', minVersion: '3.1.0' }]),
      } as never,
      2,
      { userId: 'ba-1', agency: 'human' } as never,
      'web',
    );
    expect(out.refusals).toBeNull();
    expect(state.order.slice(-2)).toEqual(['lock admin-rest-v1', 'insert admin-rest-v1']);
    expect(state.waits).toEqual([
      expect.objectContaining({
        issueId: 'i1',
        providerProjectId: 'prov-1',
        contractSlug: 'admin-rest-v1',
        minVersion: '3.1.0',
        createdBy: 'ba-1',
      }),
    ]);
    const filed = (out.effect as { issues: { contractWaits: unknown[] }[] }).issues[0];
    expect(filed?.contractWaits).toEqual([
      {
        waitId: 'w1',
        contract: 'catalog-api/admin-rest-v1',
        minVersion: '3.1.0',
        dueAt: null,
        settledVersion: null,
      },
    ]);
  });

  it('writes no wait when the accept-time check refuses it', async () => {
    state.waits.length = 0;
    const out = await breakdownEffect(
      tx as never,
      'p1',
      {
        id: 's1',
        kind: 'breakdown',
        requirementId: 'r1',
        payload: payload([{ contract: 'catalog-api/nope', minVersion: '3.1.0' }]),
      } as never,
      2,
      { userId: 'ba-1', agency: 'human' } as never,
      'web',
    );
    expect(out.refusals?.map((r) => r.code)).toEqual(['CONTRACT_WAIT_CONTRACT_UNKNOWN']);
    expect(state.waits).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = { KNOWLEDGE_INJECTION_ENABLED: false };
vi.mock('../config/env.js', () => ({ env: envMock }));

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const upsertMock = vi.fn().mockResolvedValue({});
vi.mock('../knowledge/service.js', () => ({
  upsertKnowledgeEntry: (...args: unknown[]) => upsertMock(...args),
}));

let selectCallIndex = 0;
let rulesRows: Array<{ group: string; text: string; status: string; orderIndex: number }> = [];
let projectRows: Array<{ agentConfig: unknown }> = [];
const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const idx = selectCallIndex++;
        // cm:why recompileAndPersistUxContract selects uxContractRules before projects, in that fixed order
        if (idx === 0) {
          return { where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(rulesRows)) })) };
        }
        return { where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(projectRows)) })) };
      }),
    })),
    update: vi.fn(() => ({ set: updateSetMock })),
  },
}));

const { recompileAndPersistUxContract } = await import('./ux-contract-recompile.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectCallIndex = 0;
  envMock.KNOWLEDGE_INJECTION_ENABLED = false;
  rulesRows = [{ group: 'designSystem', text: 'Reuse tokens.', status: 'active', orderIndex: 0 }];
  projectRows = [{ agentConfig: {} }];
  updateWhereMock.mockResolvedValue(undefined);
});

describe('recompileAndPersistUxContract — knowledge_entries write-through parity', () => {
  it('flag OFF: skips upsertKnowledgeEntry, still persists agentConfig.projectFacts', async () => {
    await recompileAndPersistUxContract(PROJECT_ID);

    expect(upsertMock).not.toHaveBeenCalled();
    const updatedAc = updateSetMock.mock.calls[0]?.[0] as { agentConfig: Record<string, unknown> };
    const facts = updatedAc.agentConfig.projectFacts as Record<string, string>;
    expect(facts['ux-contract']).toContain('UX Completeness Contract');
  });

  it("flag ON + projectFactsConfig['ux-contract'].alwaysInject===true: injection='always'", async () => {
    envMock.KNOWLEDGE_INJECTION_ENABLED = true;
    projectRows = [
      { agentConfig: { projectFactsConfig: { 'ux-contract': { alwaysInject: true } } } },
    ];

    await recompileAndPersistUxContract(PROJECT_ID);

    expect(upsertMock).toHaveBeenCalledOnce();
    const call = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.slug).toBe('ux-contract');
    expect(call.kind).toBe('guide');
    expect(call.confidence).toBe('verified');
    expect(call.authoredBy).toBe('human');
    expect(call.injection).toBe('always');
    expect(call.body).toContain('UX Completeness Contract');
  });

  it('flag ON + no alwaysInject config: injection=on_demand', async () => {
    envMock.KNOWLEDGE_INJECTION_ENABLED = true;
    projectRows = [{ agentConfig: {} }];

    await recompileAndPersistUxContract(PROJECT_ID);

    expect(upsertMock).toHaveBeenCalledOnce();
    const call = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.injection).toBe('on_demand');
  });

  it('write-through failure does not throw and does not block the agentConfig write', async () => {
    envMock.KNOWLEDGE_INJECTION_ENABLED = true;
    upsertMock.mockRejectedValueOnce(new Error('boom'));

    await expect(recompileAndPersistUxContract(PROJECT_ID)).resolves.toBeUndefined();
    expect(updateWhereMock).toHaveBeenCalledOnce();
  });
});

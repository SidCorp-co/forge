import { beforeEach, describe, expect, it, vi } from 'vitest';
import { designSystemRuleTexts, detectDesignSystem } from './ux-stack-scan.js';

interface RuleRow {
  id: string;
  text: string;
  status: string;
  source: string;
  orderIndex: number;
}

let selectCallIndex = 0;
let profileRow: { agentConfig: unknown } | undefined;
let existingRulesRows: RuleRow[] = [];

const updateSetMock = vi.fn((_v: unknown) => ({ where: vi.fn().mockResolvedValue(undefined) }));
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const deleteWhereMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const idx = selectCallIndex++;
        // cm:why applyUxScan selects the project profile row, then the existing rules, every call — alternate per call, not just once
        if (idx % 2 === 0) {
          return {
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(profileRow ? [profileRow] : [])),
            })),
          };
        }
        return { where: vi.fn(() => Promise.resolve(existingRulesRows)) };
      }),
    })),
    update: vi.fn(() => ({ set: updateSetMock })),
    insert: vi.fn(() => ({ values: insertValuesMock })),
    delete: vi.fn(() => ({ where: deleteWhereMock })),
  },
}));

const recompileMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./ux-contract-recompile.js', () => ({
  recompileAndPersistUxContract: (...args: unknown[]) => recompileMock(...args),
}));

const { applyUxScan } = await import('./ux-stack-apply.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY_SNAPSHOT = { packageDir: 'packages/web-v2', dependencies: {}, filePaths: [] };
// Differs from EMPTY_SNAPSHOT only by a tokenSource hit — drifts orderIndex 2 only.
const DRIFTED_SNAPSHOT = {
  packageDir: 'packages/web-v2',
  dependencies: {},
  filePaths: ['src/styles/tokens.css'],
};

const baseGenerated = designSystemRuleTexts(detectDesignSystem(EMPTY_SNAPSHOT));
const driftedGenerated = designSystemRuleTexts(detectDesignSystem(DRIFTED_SNAPSHOT));

function activeRowsFrom(generated: typeof baseGenerated): RuleRow[] {
  return generated.map((t) => ({
    id: `active-${t.orderIndex}`,
    text: t.text,
    status: 'active',
    source: 'detected',
    orderIndex: t.orderIndex,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectCallIndex = 0;
  profileRow = { agentConfig: {} };
  existingRulesRows = [];
});

describe('applyUxScan', () => {
  it('first run: writes 4 active source:detected rows and recompiles (AC #2)', async () => {
    const result = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(result.mode).toBe('created');
    expect(result.activeWritten).toBe(4);
    expect(insertValuesMock).toHaveBeenCalledOnce();
    const inserted = insertValuesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(4);
    for (const row of inserted) {
      expect(row.status).toBe('active');
      expect(row.source).toBe('detected');
      expect(row.group).toBe('designSystem');
    }
    expect(recompileMock).toHaveBeenCalledOnce();
  });

  it('drifted re-run: leaves active rows untouched, proposes only the changed rule (AC #3)', async () => {
    existingRulesRows = activeRowsFrom(baseGenerated);

    const result = await applyUxScan(PROJECT_ID, DRIFTED_SNAPSHOT);

    expect(result.mode).toBe('proposed');
    expect(result.proposed).toBe(1);
    expect(insertValuesMock).toHaveBeenCalledOnce();
    const inserted = insertValuesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.status).toBe('proposed');
    expect(inserted[0]?.source).toBe('detected');
    expect(inserted[0]?.orderIndex).toBe(2);
    expect(inserted[0]?.text).toBe(driftedGenerated[2]?.text);
    // Active rows are never deleted or updated.
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it('unchanged re-run is idempotent across two consecutive calls — no writes, no duplicates (AC #4)', async () => {
    existingRulesRows = activeRowsFrom(baseGenerated);

    const first = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);
    expect(first.mode).toBe('unchanged');
    expect(first.activeWritten).toBe(0);
    expect(first.proposed).toBe(0);

    const second = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);
    expect(second.mode).toBe('unchanged');

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(recompileMock).not.toHaveBeenCalled();
  });

  it('a resolved drift deletes the stale detected proposal and reports unchanged (self-correcting)', async () => {
    existingRulesRows = [
      ...activeRowsFrom(baseGenerated),
      {
        id: 'stale-prop-2',
        text: 'some outdated proposed text',
        status: 'proposed',
        source: 'detected',
        orderIndex: 2,
      },
    ];

    const result = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(result.mode).toBe('unchanged');
    expect(deleteWhereMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('never deletes a proposed row from a non-detected source (preset/manual/learned)', async () => {
    existingRulesRows = [
      ...activeRowsFrom(baseGenerated),
      {
        id: 'manual-prop',
        text: 'a human-authored proposal',
        status: 'proposed',
        source: 'manual',
        orderIndex: 2,
      },
    ];

    await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it('updates agentConfig.uxContractProfile.designSystem on every scan while preserving other profile + agentConfig keys', async () => {
    profileRow = {
      agentConfig: {
        someOtherKey: 'x',
        uxContractProfile: {
          projectLabel: 'Foo',
          bindingScope: 'foo/',
          knownGaps: ['gap1'],
          ruleOverrides: { 'ds-tokens': 'custom text' },
        },
      },
    };

    await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(updateSetMock).toHaveBeenCalledOnce();
    const updated = updateSetMock.mock.calls[0]?.[0] as { agentConfig: Record<string, unknown> };
    expect(updated.agentConfig.someOtherKey).toBe('x');
    const profile = updated.agentConfig.uxContractProfile as Record<string, unknown>;
    expect(profile.projectLabel).toBe('Foo');
    expect(profile.knownGaps).toEqual(['gap1']);
    expect(profile.ruleOverrides).toEqual({ 'ds-tokens': 'custom text' });
    expect(profile.designSystem).toEqual(detectDesignSystem(EMPTY_SNAPSHOT));
  });
});

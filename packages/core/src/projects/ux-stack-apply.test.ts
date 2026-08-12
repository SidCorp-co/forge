import { beforeEach, describe, expect, it, vi } from 'vitest';
import { designSystemRuleTexts, detectDesignSystem } from './ux-stack-scan.js';

interface RuleRow {
  id: string;
  text: string;
  status: string;
  source: string;
  orderIndex: number;
}

let profileRow: { agentConfig: unknown } | undefined;
let existingRulesRows: RuleRow[] = [];
// Overrides the "does any ux_contract_rules row exist for this project, in
// ANY group" probe independently of `existingRulesRows` (which is always the
// designSystem-group-scoped list) — needed to model a project that already
// has rules in another group while designSystem is still empty.
let anyRuleRowOverride: RuleRow[] | null = null;

const updateSetMock = vi.fn((_v: unknown) => ({
  where: vi.fn().mockResolvedValue(undefined),
}));
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
const executeMock = vi.fn().mockResolvedValue(undefined);

// cm:why `select`'s field-spec shape (not call order) picks the response —
// applyUxScan now issues a variable number of selects per run (profile,
// designSystem-scoped rules, an any-group existence probe, and a second
// profile read for the hand-authored-contract check), so an order-based
// alternation would silently mis-serve as soon as a branch adds/drops a call.
function selectMock(spec: Record<string, unknown>) {
  const keys = Object.keys(spec ?? {});
  return {
    from: vi.fn(() => {
      if (keys.length === 1 && keys[0] === 'agentConfig') {
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(profileRow ? [profileRow] : [])),
          })),
        };
      }
      if (keys.length === 1 && keys[0] === 'id') {
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() =>
              Promise.resolve(anyRuleRowOverride ?? existingRulesRows.slice(0, 1)),
            ),
          })),
        };
      }
      return { where: vi.fn(() => Promise.resolve(existingRulesRows)) };
    }),
  };
}

const dbMock = {
  select: vi.fn(selectMock),
  update: vi.fn(() => ({ set: updateSetMock })),
  insert: vi.fn(() => ({ values: insertValuesMock })),
  delete: vi.fn(() => ({ where: deleteWhereMock })),
  execute: executeMock,
  transaction: vi.fn(async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock)),
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

const recompileMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./ux-contract-recompile.js', () => ({
  recompileAndPersistUxContract: (...args: unknown[]) => recompileMock(...args),
}));

const { applyUxScan } = await import('./ux-stack-apply.js');

// cm:why drizzle's `sql` template objects don't stringify usefully — walk
// queryChunks (mirrors pipeline/orchestrator.test.ts's helper of the same name)
function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
  let text = '';
  for (const c of chunks) {
    if (typeof c !== 'object' || c === null) continue;
    if ('queryChunks' in c) {
      text += sqlTextOf(c);
      continue;
    }
    if ('value' in c) {
      const v = (c as { value?: unknown }).value;
      text += Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').join(' ') : '';
    }
  }
  return text;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY_SNAPSHOT = {
  packageDir: 'packages/web-v2',
  dependencies: {},
  filePaths: [],
};
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
  profileRow = { agentConfig: {} };
  existingRulesRows = [];
  anyRuleRowOverride = null;
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

  it('first run takes a per-project advisory lock before checking for existing rows (ISS-576 review #4)', async () => {
    await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(executeMock).toHaveBeenCalledOnce();
    expect(sqlTextOf(executeMock.mock.calls[0]?.[0])).toMatch(/pg_advisory_xact_lock/);
  });

  it('first run with a hand-authored contract and no rules at all: proposes instead of ' +
    'activating, and never recompiles (ISS-576 review blocker)', async () => {
    profileRow = {
      agentConfig: { projectFacts: { 'ux-contract': 'hand-written prose' } },
    };

    const result = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(result.mode).toBe('proposed');
    expect(result.activeWritten).toBe(0);
    expect(result.proposed).toBe(4);
    expect(insertValuesMock).toHaveBeenCalledOnce();
    const inserted = insertValuesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(4);
    for (const row of inserted) {
      expect(row.status).toBe('proposed');
      expect(row.source).toBe('detected');
    }
    expect(recompileMock).not.toHaveBeenCalled();
  });

  it('first run with a hand-authored contract but existing rules elsewhere: activates normally (already migrated off prose)', async () => {
    profileRow = {
      agentConfig: { projectFacts: { 'ux-contract': 'compiled prose' } },
    };
    // designSystem group is still empty, but a row in another group means
    // recompile has already run once — the hand-authored-only guard (which
    // only fires when NO rule exists in ANY group) should not apply.
    anyRuleRowOverride = [
      {
        id: 'flows-1',
        text: 'some flows rule',
        status: 'active',
        source: 'preset',
        orderIndex: 0,
      },
    ];

    const result = await applyUxScan(PROJECT_ID, EMPTY_SNAPSHOT);

    expect(result.mode).toBe('created');
    expect(result.activeWritten).toBe(4);
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
    const updated = updateSetMock.mock.calls[0]?.[0] as {
      agentConfig: Record<string, unknown>;
    };
    expect(updated.agentConfig.someOtherKey).toBe('x');
    const profile = updated.agentConfig.uxContractProfile as Record<string, unknown>;
    expect(profile.projectLabel).toBe('Foo');
    expect(profile.knownGaps).toEqual(['gap1']);
    expect(profile.ruleOverrides).toEqual({ 'ds-tokens': 'custom text' });
    expect(profile.designSystem).toEqual(detectDesignSystem(EMPTY_SNAPSHOT));
  });
});

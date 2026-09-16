// Until ISS-1048 this file tested write-through PARITY: the compiled contract was written to
// `agentConfig.projectFacts['ux-contract']` and, behind a flag, mirrored into `knowledge_entries`.
// There is one write now and no flag, so what is worth pinning changed with it — not "do both
// stores agree" but "does the one store get the prose, and does it get it flagged for delivery".

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: {} }));

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const upsertMock = vi.fn().mockResolvedValue({});
vi.mock('../knowledge/service.js', () => ({
  upsertKnowledgeEntry: (...args: unknown[]) => upsertMock(...args),
}));

let selectCallIndex = 0;
let rulesRows: Array<{ group: string; text: string; status: string; orderIndex: number }> = [];
let projectRows: Array<{ agentConfig: unknown }> = [];
let entryRows: Array<{ injection: string }> = [];
const updateSetMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const idx = selectCallIndex++;
        // cm:why the three selects run in this fixed order: the active rules, then the project row
        // for its scaffold, then the existing knowledge entry for the injection setting it already
        // carries. Keyed by call index, so a select added ahead of one of these silently reassigns
        // every fixture below — the order is the contract this mock depends on.
        if (idx === 0) {
          return { where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(rulesRows)) })) };
        }
        if (idx === 1) {
          return { where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(projectRows)) })) };
        }
        return { where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(entryRows)) })) };
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
  rulesRows = [{ group: 'designSystem', text: 'Reuse tokens.', status: 'active', orderIndex: 0 }];
  projectRows = [{ agentConfig: {} }];
  entryRows = [];
  upsertMock.mockResolvedValue({});
});

describe('recompileAndPersistUxContract', () => {
  it('writes the compiled prose to the ux-contract entry as verified, human-authored guide', async () => {
    await recompileAndPersistUxContract(PROJECT_ID);

    expect(upsertMock).toHaveBeenCalledOnce();
    const call = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.projectId).toBe(PROJECT_ID);
    expect(call.slug).toBe('ux-contract');
    expect(call.kind).toBe('guide');
    expect(call.confidence).toBe('verified');
    expect(call.authoredBy).toBe('human');
    expect(call.body).toContain('UX Completeness Contract');
    expect(call.body).toContain('Reuse tokens.');
  });

  // cm:guard writing the prose is only half of shipping it. Measured on forge-beta 2026-08-31:
  // `qa-project-available-for-testing` had 22 active rules compiled to 2,925 characters with the
  // always-inject flag unset since 2026-08-11 — applied by the Settings button, injected nowhere,
  // zero findings. A new entry defaults ON, or the contract reaches no agent at all.
  it('flags a brand-new entry always, since a contract nobody injected reaches nobody', async () => {
    entryRows = [];

    await recompileAndPersistUxContract(PROJECT_ID);

    expect(upsertMock.mock.calls[0]?.[0]?.injection).toBe('always');
  });

  // cm:guard the auto-ON default applies ONLY where there is no entry. An operator who set this to
  // `on_demand` or `none` made a decision, and a recompile that re-flags it every save would
  // overrule a human silently — which is the one thing the default is not allowed to do.
  it.each(['on_demand', 'none', 'always'])(
    'leaves an existing entry at the %s its owner chose',
    async (injection) => {
      entryRows = [{ injection }];

      await recompileAndPersistUxContract(PROJECT_ID);

      expect(upsertMock.mock.calls[0]?.[0]?.injection).toBe(injection);
    },
  );

  // cm:guard the knowledge entry IS the contract now. When it was a best-effort mirror of an
  // `agentConfig` write, a failure could be warned about and swallowed; warning about the only
  // write there is would answer the operator's save with a success that stored nothing.
  it('lets a failed write reach the caller rather than reporting a save that stored nothing', async () => {
    upsertMock.mockRejectedValueOnce(new Error('boom'));

    await expect(recompileAndPersistUxContract(PROJECT_ID)).rejects.toThrow('boom');
  });

  it('writes nothing at all when the project row is gone', async () => {
    projectRows = [];

    await expect(recompileAndPersistUxContract(PROJECT_ID)).resolves.toBeUndefined();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  // cm:guard `agentConfig` is no longer written by this path. An UPDATE surviving here would put
  // the contract prose back in the jsonb blob that ISS-1048 emptied, and the next reader would
  // find two copies with no way to tell which one the operator last saved.
  it('touches agentConfig not at all', async () => {
    await recompileAndPersistUxContract(PROJECT_ID);

    expect(updateSetMock).not.toHaveBeenCalled();
  });
});

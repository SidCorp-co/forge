import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard the queue mock is order-sensitive: each db.select().from().where() consumes the NEXT queued result, awaited directly or via .limit(). A test that adds a query without queueing a row for it silently steals the next test's row instead of failing where the gap is.
const selectQueue: unknown[][] = [];
const labelInsertMock = vi.fn();
const issueLabelInsertMock = vi.fn();
const selectCalls = { n: 0 };
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls.n += 1;
          const rows = selectQueue.shift() ?? [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
    insert: (table: { _table?: unknown }) => ({
      values: (v: Record<string, unknown>) => {
        // labels insert carries `name`; issue_labels carries `labelId`.
        const isLabel = 'name' in v;
        const mock = isLabel ? labelInsertMock : issueLabelInsertMock;
        return {
          onConflictDoNothing: () => {
            const r = mock(v);
            const p = Promise.resolve(r ?? []) as Promise<unknown[]> & {
              returning: () => Promise<unknown[]>;
            };
            p.returning = () => Promise.resolve(r ?? []);
            return p;
          },
        };
      },
    }),
  },
}));

const emitNotificationMock = vi.fn<(payload?: unknown) => Promise<unknown>>();
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (input: unknown) => emitNotificationMock(input),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { admitGithubIssue, applyIntakeGate, finalizeIntake, resolveIntakeGate } = await import(
  './intake-gate.js'
);

const PROJECT = 'p-1';
const gatedConfig = { agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } };

beforeEach(() => {
  selectQueue.length = 0;
  selectCalls.n = 0;
  labelInsertMock.mockReset();
  labelInsertMock.mockReturnValue([{ id: 'label-1' }]);
  issueLabelInsertMock.mockReset();
  issueLabelInsertMock.mockReturnValue([]);
  emitNotificationMock.mockReset();
  emitNotificationMock.mockResolvedValue({ id: 'n-1' });
});

describe('resolveIntakeGate', () => {
  it('absent config → disabled, notify defaults true', async () => {
    selectQueue.push([{ agentConfig: {} }]);
    expect(await resolveIntakeGate(PROJECT)).toEqual({ enabled: false, notify: true });
  });

  it('enabled with notify:false honored', async () => {
    selectQueue.push([
      { agentConfig: { pipelineConfig: { intakeGate: { enabled: true, notify: false } } } },
    ]);
    expect(await resolveIntakeGate(PROJECT)).toEqual({ enabled: true, notify: false });
  });
});

describe('admitGithubIssue (ISS-1076)', () => {
  it('a project that never set the key is closed, and says which door refused', async () => {
    selectQueue.push([{ agentConfig: {} }]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: false,
      reason: 'github-intake-closed',
    });
  });

  it('a project with no row at all is closed rather than open by omission', async () => {
    selectQueue.push([]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: false,
      reason: 'github-intake-closed',
    });
  });

  it('an explicit false is closed', async () => {
    selectQueue.push([{ agentConfig: { pipelineConfig: { githubIntake: { enabled: false } } } }]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: false,
      reason: 'github-intake-closed',
    });
  });

  // cm:guard `enabled` is read for the boolean `true` and not for truthiness: the schema refuses a string, but this reader stands over a jsonb column an older document could have been written to before the schema declared the key, and `'false'` is truthy.
  it('a truthy non-boolean does not open the door', async () => {
    selectQueue.push([{ agentConfig: { pipelineConfig: { githubIntake: { enabled: 'false' } } } }]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: false,
      reason: 'github-intake-closed',
    });
  });

  it('open door, intake gate off → admitted at open', async () => {
    selectQueue.push([{ agentConfig: { pipelineConfig: { githubIntake: { enabled: true } } } }]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: true,
      status: 'open',
      gated: false,
    });
  });

  it('open door, intake gate on → admitted at draft, gated', async () => {
    selectQueue.push([
      {
        agentConfig: {
          pipelineConfig: { githubIntake: { enabled: true }, intakeGate: { enabled: true } },
        },
      },
    ]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: true,
      status: 'draft',
      gated: true,
    });
  });

  // cm:guard the two settings are read from ONE document, so an intakeGate on its own never opens this door. A reader that fell back to intakeGate would admit on three of the fleet's projects that turned the gate on and were never asked about GitHub at all.
  it('an intake gate on its own opens nothing', async () => {
    selectQueue.push([{ agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } }]);
    expect(await admitGithubIssue(PROJECT)).toEqual({
      admitted: false,
      reason: 'github-intake-closed',
    });
  });

  // cm:guard ONE select for both settings, counted rather than inferred from the queue: an exhausted queue returns `[]` rather than throwing, so a second read would drain the queue and still leave it empty. The count is what can go red.
  it('reads the project document once', async () => {
    selectQueue.push([{ agentConfig: { pipelineConfig: { githubIntake: { enabled: true } } } }]);
    await admitGithubIssue(PROJECT);
    expect(selectCalls.n).toBe(1);
  });
});

describe('applyIntakeGate', () => {
  it('non-open creates pass through without even reading config', async () => {
    expect(await applyIntakeGate(PROJECT, 'draft')).toEqual({ status: 'draft', gated: false });
    expect(await applyIntakeGate(PROJECT, 'on_hold')).toEqual({ status: 'on_hold', gated: false });
  });

  it('ungated project: open stays open', async () => {
    selectQueue.push([{ agentConfig: {} }]);
    expect(await applyIntakeGate(PROJECT, 'open')).toEqual({ status: 'open', gated: false });
  });

  it('gated project: open is parked at draft', async () => {
    selectQueue.push([gatedConfig]);
    expect(await applyIntakeGate(PROJECT, 'open')).toEqual({ status: 'draft', gated: true });
  });
});

describe('finalizeIntake', () => {
  it('attaches the intake label and notifies the project owner', async () => {
    selectQueue.push([]); // no existing label → create
    selectQueue.push([gatedConfig]); // notify config read
    selectQueue.push([{ createdBy: 'owner-1' }]); // project owner
    await finalizeIntake(PROJECT, { id: 'i-1', title: 'Bug from the public form' });

    expect(labelInsertMock).toHaveBeenCalledTimes(1);
    expect(issueLabelInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'i-1', labelId: 'label-1' }),
    );
    const n = emitNotificationMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(n.userId).toBe('owner-1');
    expect(n.type).toBe('intake_pending');
    expect(n.issueId).toBe('i-1');
  });

  it('reuses an existing intake label', async () => {
    selectQueue.push([{ id: 'label-9' }]); // existing label
    selectQueue.push([gatedConfig]);
    selectQueue.push([{ createdBy: 'owner-1' }]);
    await finalizeIntake(PROJECT, { id: 'i-1', title: 't' });
    expect(labelInsertMock).not.toHaveBeenCalled();
    expect(issueLabelInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ labelId: 'label-9' }),
    );
  });

  it('notify:false skips the notification but still labels', async () => {
    selectQueue.push([{ id: 'label-9' }]);
    selectQueue.push([
      { agentConfig: { pipelineConfig: { intakeGate: { enabled: true, notify: false } } } },
    ]);
    await finalizeIntake(PROJECT, { id: 'i-1', title: 't' });
    expect(issueLabelInsertMock).toHaveBeenCalled();
    expect(emitNotificationMock).not.toHaveBeenCalled();
  });

  it('never throws — label/notify failures are contained', async () => {
    labelInsertMock.mockImplementation(() => {
      throw new Error('db down');
    });
    selectQueue.push([]); // label lookup
    selectQueue.push([gatedConfig]);
    selectQueue.push([{ createdBy: 'owner-1' }]);
    await expect(finalizeIntake(PROJECT, { id: 'i-1', title: 't' })).resolves.toBeUndefined();
    // notification path still ran despite the label failure
    expect(emitNotificationMock).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queue-based select mock (same style as skills/template-propagation.test.ts):
// each db.select().from().where() consumes the next queued result; awaitable
// directly and via .limit().
const selectQueue: unknown[][] = [];
const labelInsertMock = vi.fn();
const issueLabelInsertMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
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

const emitNotificationMock = vi.fn();
vi.mock('../notifications/emit.js', () => ({
  emitNotification: (input: unknown) => emitNotificationMock(input),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applyIntakeGate, finalizeIntake, resolveIntakeGate } = await import('./intake-gate.js');

const PROJECT = 'p-1';
const gatedConfig = { agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } };

beforeEach(() => {
  selectQueue.length = 0;
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
    const n = emitNotificationMock.mock.calls[0][0] as Record<string, unknown>;
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

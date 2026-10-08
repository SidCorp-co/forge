import type { ReportRun } from '@forge/contracts/report-queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';

// A block reaches a room only through attachVisualBlock: its run is read back as the asker, the run's
// frame is copied in, and the registry checks the whole. A figure the run never read, a run the asker
// may not read, a run of another project and a room that draws no block are each refused by name, and
// nothing is posted.

const readReportRun = vi.fn();
vi.mock('./runs.js', async (original) => ({
  ...(await original<typeof import('./runs.js')>()),
  readReportRun: (...args: unknown[]) => readReportRun(...args),
}));

const { attachVisualBlock } = await import('./blocks.js');
const { provideReportsPorts } = await import('./ports.js');
const { refuse } = await import('./runs.js');

const run: ReportRun = {
  runId: 'run-1',
  queryId: 'progress-by-requirement',
  version: 1,
  params: {},
  projectId: 'p1',
  actor: { kind: 'human', id: 'asker' },
  asOf: '2026-10-08T09:30:00.000Z',
  frame: {
    fields: [
      { name: 'key', type: 'ref', label: 'Requirement' },
      { name: 'proven', type: 'number', label: 'Proven' },
    ],
    rows: [
      { key: 'REQ-1', proven: 3 },
      { key: 'REQ-2', proven: 5 },
    ],
  },
};

const posted: unknown[] = [];
let adapter = 'web';
beforeEach(() => {
  posted.length = 0;
  adapter = 'web';
  readReportRun.mockReset();
  readReportRun.mockResolvedValue(run);
  provideReportsPorts({
    runQuery: async () => run,
    describeQuery: () => {
      throw new Error('not read here');
    },
    listQueries: () => [],
    roomOf: async () => ({ adapter, projectIds: ['p1'] }),
    messageOf: async () => null,
    postAnswer: async (answer) => {
      posted.push(answer);
      return { messageId: 'm1' };
    },
  });
});

const attach = (raw: unknown, projectId = 'p1') =>
  attachVisualBlock({
    conversationId: 'c1',
    projectId,
    raw,
    asker: { userId: 'asker', agency: 'human' },
  });
const table = { kind: 'table', columns: ['key', 'proven'], source: { runId: 'run-1' } };

async function refusalOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

describe('attaching a visual block', () => {
  it("copies the run's frame in and posts the block with its run's query and read time", async () => {
    const attached = await attach(table);
    expect(attached).toMatchObject({
      messageId: 'm1',
      kind: 'table',
      run: { runId: 'run-1', queryId: 'progress-by-requirement', asOf: run.asOf },
    });
    expect(posted).toEqual([
      {
        conversationId: 'c1',
        projectId: 'p1',
        askerUserId: 'asker',
        content: attached.text,
        blocks: [
          {
            type: 'visual',
            visual: { v: 1, ...table, frame: run.frame },
            run: { runId: 'run-1', queryId: 'progress-by-requirement', version: 1, asOf: run.asOf },
          },
        ],
      },
    ]);
    expect(attached.text).toContain('| REQ-2 | 5 |');
  });

  it('refuses a figure the run never read, naming the cell, and posts nothing', async () => {
    const typed = structuredClone(run.frame);
    (typed.rows[0] as Record<string, unknown>).proven = 30;
    const err = await refusalOf(attach({ ...table, frame: typed }));
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    expect((err as Error).message).toContain(
      'frame.rows.0.proven: the block holds 30, run run-1 read 3',
    );
    expect(posted).toEqual([]);
  });

  it("accepts a frame that is exactly its run's", async () => {
    await attach({ ...table, frame: structuredClone(run.frame) });
    expect(posted).toHaveLength(1);
  });

  it('refuses a figure typed as a key of the block, since a block holds none of its own', async () => {
    const err = await refusalOf(attach({ ...table, total: 8 }));
    expect(isRefusal(err, 'REPORT_BLOCK_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('a block holds no figure of its own');
    expect(posted).toEqual([]);
  });

  it('refuses a run the asker may not read, as the reader refused it, and posts nothing', async () => {
    readReportRun.mockRejectedValue(
      refuse('REPORT_RUN_READ_FORBIDDEN', 'report run run-1 was read as another member'),
    );
    const err = await refusalOf(attach(table));
    expect(isRefusal(err, 'REPORT_RUN_READ_FORBIDDEN')).toBe(true);
    expect(readReportRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', userId: 'asker' }),
    );
    expect(posted).toEqual([]);
  });

  it('refuses a run of another project than the answer', async () => {
    readReportRun.mockResolvedValue({ ...run, projectId: 'p2' });
    expect(isRefusal(await refusalOf(attach(table)), 'REPORT_RUN_OTHER_PROJECT')).toBe(true);
  });

  it('refuses a room whose door draws no block, by its door', async () => {
    adapter = 'rocketchat';
    const err = await refusalOf(attach(table));
    expect(isRefusal(err, 'REPORT_BLOCK_ROOM_NOT_WEB')).toBe(true);
    expect((err as Error).message).toContain('is a rocketchat room');
    expect(readReportRun).not.toHaveBeenCalled();
  });

  it('refuses a block the registry refuses, naming the field and the valid shape', async () => {
    const err = await refusalOf(attach({ ...table, columns: ['velocity'] }));
    expect(isRefusal(err, 'REPORT_BLOCK_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('"velocity" is not a field of the frame');
    expect((err as Error).message).toContain('valid shape');
  });

  it('refuses a block naming no run unless it is a flow, and one sourced from an execution', async () => {
    const { source: _s, ...unsourced } = table;
    expect(((await refusalOf(attach(unsourced))) as Error).message).toContain('source');
    expect(
      isRefusal(
        await refusalOf(attach({ ...table, source: { executionId: 'x' } })),
        'REPORT_BLOCK_SOURCE_UNSUPPORTED',
      ),
    ).toBe(true);
    const flow = {
      kind: 'flow',
      nodes: [
        { id: 'a', label: 'Ask' },
        { id: 'b', label: 'Answer' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(await attach(flow)).toMatchObject({ kind: 'flow', run: null });
  });
});

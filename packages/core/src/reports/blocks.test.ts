import type { ReportRun } from '@forge/contracts/report-queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import type { BlockStage, StagedBlock } from '../lib/staged-block.js';

// A block reaches a room only through attachVisualBlock: its run is read back as the asker, the run's
// frame is copied in, and the registry checks the whole. A figure the run never read — in its frame or
// typed into its title or a label — a run the asker may not read, a run of another project and a room
// that draws no block are each refused by name, and nothing is posted. A block drawn on a turn's stage
// waits there, and nothing is posted until its reply passes (REQ-32 criteria 5 and 6).

const readReportRun = vi.fn();
vi.mock('./runs.js', async (original) => ({
  ...(await original<typeof import('./runs.js')>()),
  readReportRun: (...args: unknown[]) => readReportRun(...args),
}));
vi.mock('../lib/people.js', () => ({
  userNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, `Person ${id}`])),
}));
const readExecution = vi.fn();
vi.mock('./executions.js', async (original) => ({
  ...(await original<typeof import('./executions.js')>()),
  readExecution: (...args: unknown[]) => readExecution(...args),
}));

const { attachVisualBlock } = await import('./blocks.js');
const { provideReportsPorts } = await import('./ports.js');
const { refuse } = await import('./runs.js');

const run: ReportRun = {
  runId: 'run-1',
  queryId: 'progress-by-requirement',
  version: 1,
  params: { windowDays: 30 },
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
  held.length = 0;
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
    turnOf: async () => null,
    postAnswer: async (answer) => {
      posted.push(answer);
      return { messageId: 'm1' };
    },
    restTurnOf: async () => ({ kind: 'none' }),
  });
});

const attach = (raw: unknown, projectId = 'p1', stage: BlockStage | null = null) =>
  attachVisualBlock({
    conversationId: 'c1',
    projectId,
    raw,
    asker: { userId: 'asker', agency: 'human' },
    stage,
  });
const held: StagedBlock[] = [];
const stageOf = (): BlockStage => ({
  hold: async (b) => {
    held.push(b);
  },
});
const kpi = (label: string, title?: string) => ({
  kind: 'kpi',
  figures: [
    { field: 'proven', label },
    { field: 'proven', label: 'Proven' },
  ],
  ...(title ? { title } : {}),
  source: { runId: 'run-1' },
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
            run: {
              runId: 'run-1',
              queryId: 'progress-by-requirement',
              version: 1,
              asOf: run.asOf,
              params: { windowDays: 30 },
            },
          },
        ],
      },
    ]);
    expect(attached.text).toContain('| REQ-2 | 5 |');
  });

  it("keeps the settings the run read with beside the block, so its source can show them (BC-2)", async () => {
    const attached = await attach(table);
    expect(attached.run?.params).toEqual({ windowDays: 30 });
  });

  it('hands the model its dates as ISO and stores the UTC reading, so the model never copies a server-made UTC time (BC-4, BC-17)', async () => {
    const dated: ReportRun = {
      ...run,
      frame: {
        fields: [
          { name: 'key', type: 'ref', label: 'Requirement' },
          { name: 'shipped', type: 'date', label: 'Shipped' },
        ],
        rows: [{ key: 'REQ-1', shipped: '2026-10-09T01:03:00.000Z' }],
      },
    };
    readReportRun.mockResolvedValue(dated);
    const attached = await attach({ kind: 'table', columns: ['key', 'shipped'], source: { runId: 'run-1' } });
    expect(attached.text).toContain('2026-10-09T01:03:00.000Z');
    expect(attached.text).not.toContain('UTC');
    expect((posted[0] as { content: string }).content).toContain('Oct 9, 01:03 UTC');
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

  it('refuses a block naming no source unless it is a flow', async () => {
    const { source: _s, ...unsourced } = table;
    expect(((await refusalOf(attach(unsourced))) as Error).message).toContain('source');
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

describe('a block drawn from an execution', () => {
  const computedFrame = {
    fields: [
      { name: 'key', type: 'ref' as const, label: 'Requirement' },
      { name: 'ratio', type: 'number' as const, label: 'Ratio' },
    ],
    rows: [{ key: 'REQ-1', ratio: 0.375 }],
  };
  const execution = {
    executionId: 'ex-1',
    projectId: 'p1',
    conversationId: 'c1',
    askedBy: 'asker',
    adapter: 'fake',
    language: 'javascript',
    script: 'return { frames: [] }',
    scriptFingerprint: 'a'.repeat(64),
    inputRunIds: ['run-1'],
    limits: { wallMs: 1000, cpu: 1, memoryMb: 64, outputBytes: 10_000 },
    exit: 0,
    stopped: null,
    durationMs: 12,
    frames: [computedFrame],
    logs: { stdout: '', stderr: '' },
    error: null,
    reads: [{ method: 'GET', path: '/api/projects/p1/requirements', status: 200 }],
    createdAt: '2026-10-08T10:00:00.000Z',
    expiresAt: '2026-11-07T10:00:00.000Z',
  };
  beforeEach(() => {
    readExecution.mockReset();
    readExecution.mockResolvedValue(execution);
  });

  it('copies the execution frame in, keeps the execution beside it and says it was computed', async () => {
    const answer = await attach({
      kind: 'table',
      columns: ['key', 'ratio'],
      source: { executionId: 'ex-1' },
    });
    expect(readExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'ex-1', userId: 'asker', projectId: 'p1' }),
    );
    expect(answer.execution).toEqual({
      executionId: 'ex-1',
      adapter: 'fake',
      language: 'javascript',
      at: '2026-10-08T10:00:00.000Z',
      askedBy: { id: 'asker', name: 'Person asker' },
      reads: [{ method: 'GET', path: '/api/projects/p1/requirements', status: 200 }],
      script: 'return { frames: [] }',
      result: { exit: 0, durationMs: 12, stdout: '' },
    });
    expect(answer.text).toContain('Computed by execution ex-1');
    const [post] = posted as { blocks: Record<string, unknown>[] }[];
    expect(post?.blocks[0]).toMatchObject({
      type: 'visual',
      visual: { source: { executionId: 'ex-1' }, frame: computedFrame },
      execution: { executionId: 'ex-1' },
    });
    expect(post?.blocks[0]).not.toHaveProperty('run');
  });

  it('refuses a figure the execution never returned, and names the frame to draw among several', async () => {
    const forged = { ...computedFrame, rows: [{ key: 'REQ-1', ratio: 0.9 }] };
    const err = await refusalOf(
      attach({ kind: 'table', columns: ['key'], source: { executionId: 'ex-1' }, frame: forged }),
    );
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    readExecution.mockResolvedValue({ ...execution, frames: [computedFrame, computedFrame] });
    const many = await refusalOf(
      attach({ kind: 'table', columns: ['key'], source: { executionId: 'ex-1' } }),
    );
    expect((many as Error).message).toContain('name the one drawn as source.frame, 0 to 1');
    const second = await attach({
      kind: 'table',
      columns: ['key'],
      source: { executionId: 'ex-1', frame: 1 },
    });
    expect(second.execution?.executionId).toBe('ex-1');
    expect(posted).toHaveLength(1);
  });
});

describe("a block's title and labels hold no number of their own", () => {
  it('refuses a label stating a number its run does not hold, naming it, and posts nothing', async () => {
    const err = await refusalOf(attach(kpi('Proven of 12')));
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    expect((err as Error).message).toContain(
      'the kpi block\'s label "Proven of 12" states the figure 12, which run run-1 does not hold',
    );
    expect(posted).toEqual([]);
  });

  it('refuses a typed title the same way, on a staged turn too, and holds nothing', async () => {
    const err = await refusalOf(attach(kpi('Proven', '42 shipped this week'), 'p1', stageOf()));
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    expect((err as Error).message).toContain('"42 shipped this week" states the figure 42');
    expect(held).toEqual([]);
  });

  it('passes a number the run holds', async () => {
    await attach({ ...table, title: 'Proven, best of 5' });
    expect(posted).toHaveLength(1);
  });

  // REQ-32 BC-5: what the person typed is not a report's figure, so it grounds none in a block
  it('refuses a number only the person typed in the question', async () => {
    const err = await refusalOf(attach({ ...table, title: 'Top 7 by proven' }, 'p1', stageOf()));
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    expect((err as Error).message).toContain('"Top 7 by proven" states the figure 7');
    expect(held).toEqual([]);
  });

  it('refuses any number in a flow that names no run, and keeps dates and ids', async () => {
    const flow = (label: string) => ({
      kind: 'flow',
      nodes: [
        { id: 'a', label },
        { id: 'b', label: 'REQ-3 agreed on 2026-10-08' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const err = await refusalOf(attach(flow('9 shipped')));
    expect(isRefusal(err, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN')).toBe(true);
    expect((err as Error).message).toContain('names no run to hold it');
    expect(await attach(flow('Ask'))).toMatchObject({ kind: 'flow', held: false });
  });
});

describe("a block drawn on a turn's stage", () => {
  it('waits on the stage with its run, and nothing is posted into the room', async () => {
    const attached = await attach(table, 'p1', stageOf());
    expect(attached).toMatchObject({ messageId: null, held: true, kind: 'table' });
    expect(posted).toEqual([]);
    expect(held).toEqual([
      {
        text: attached.text,
        block: {
          type: 'visual',
          visual: { v: 1, ...table, frame: run.frame },
          run: {
            runId: 'run-1',
            queryId: 'progress-by-requirement',
            version: 1,
            asOf: run.asOf,
            params: { windowDays: 30 },
          },
        },
        kind: 'table',
        runId: 'run-1',
        projectId: 'p1',
        askerUserId: 'asker',
      },
    ]);
  });
});

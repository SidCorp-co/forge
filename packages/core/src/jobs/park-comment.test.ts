import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const inserted: Array<Record<string, unknown>> = [];
let projectRows: Array<Record<string, unknown>> = [{ createdBy: 'owner-1' }];
let jobRows: Array<Record<string, unknown>> = [];
let selectCall = 0;

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // cm:why call order, not table identity — the mock cannot see which table drizzle targeted, so the first where() is the project lookup and the second is the attempt count
          const isFirst = selectCall++ === 0;
          const rows = isFirst ? projectRows : jobRows;
          const terminal = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          terminal.limit = async () => rows;
          return terminal;
        },
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    }),
  },
}));

const { postParkReasonComment } = await import('./park-comment.js');

function reset(opts?: {
  project?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
}) {
  inserted.length = 0;
  selectCall = 0;
  projectRows = opts?.project ?? [{ createdBy: 'owner-1' }];
  jobRows = opts?.jobs ?? [];
}

const BASE = {
  issueId: 'iss-1',
  projectId: 'proj-1',
  jobType: 'code',
  stageStatus: 'approved',
  reason: 'retry_rounds_exhausted',
  failureKind: 'transient',
};

describe('postParkReasonComment', () => {
  it('records the step, the no-retry reason and the attempt count', async () => {
    reset({ jobs: [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }] });
    await postParkReasonComment(BASE);

    expect(inserted).toHaveLength(1);
    const body = String(inserted[0]?.body);
    expect(body).toContain('Parked at `waiting`');
    expect(body).toContain('`code`');
    expect(body).toContain('stage `approved`');
    expect(body).toContain('`retry_rounds_exhausted`');
    expect(body).toContain('failure kind `transient`');
    expect(body).toContain('Non-successful attempts on this step:** 3');
  });

  it('attributes the comment to the project owner and marks it AI', async () => {
    reset();
    await postParkReasonComment(BASE);
    expect(inserted[0]?.authorId).toBe('owner-1');
    expect(inserted[0]?.isAi).toBe(true);
    expect(inserted[0]?.issueId).toBe('iss-1');
  });

  // cm:guard this sentence is the point of the whole comment — a re-dispatched agent that assumes the work is undone redoes shipped work, the exact ISS-213 incident
  it('says the step stopped, not that the work is undone', async () => {
    reset();
    await postParkReasonComment(BASE);
    const body = String(inserted[0]?.body);
    expect(body).toContain('the STEP stopped, not that the work is undone');
    expect(body).toContain('verify the current real state');
  });

  it('includes the last failure in a fenced block when present', async () => {
    reset();
    await postParkReasonComment({ ...BASE, failureReason: 'claude exited 137' });
    const body = String(inserted[0]?.body);
    expect(body).toContain('**Last failure:**');
    expect(body).toContain('claude exited 137');
  });

  it('truncates a huge failure message instead of pasting it whole', async () => {
    reset();
    await postParkReasonComment({ ...BASE, failureReason: 'x'.repeat(5000) });
    const body = String(inserted[0]?.body);
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(2000);
  });

  it('omits the failure block when there is no message', async () => {
    reset();
    await postParkReasonComment(BASE);
    expect(String(inserted[0]?.body)).not.toContain('**Last failure:**');
  });

  it('posts nothing when the project cannot be resolved', async () => {
    reset({ project: [] });
    await postParkReasonComment(BASE);
    expect(inserted).toHaveLength(0);
  });

  // cm:guard swallowing the error is deliberate — the park transition and run-reap that follow this call are the correctness-critical work
  it('never throws when the insert fails', async () => {
    reset();
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).insert = () => ({
      values: async () => {
        throw new Error('db down');
      },
    });
    await expect(postParkReasonComment(BASE)).resolves.toBeUndefined();
  });
});

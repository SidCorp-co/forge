/**
 * ISS-1076 — which writes each GitHub delivery issues, and for the two events this
 * door no longer answers, that it issues none.
 *
 * The removal is the deliverable, so the assertions are about the ABSENCE of a
 * write. A test asserting only the final row state would pass against a handler
 * that wrote and then wrote back; this one counts the statements reaching the db.
 * The e2e beside it asserts the stored rows against real Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
const updateMock = vi.fn();
const insertMock = vi.fn();
const selectRows: unknown[][] = [];

vi.mock('../db/client.js', () => ({
  db: {
    execute: (q: { queryChunks?: unknown[] } | string) => {
      executed.push(typeof q === 'string' ? q : JSON.stringify(q));
      return Promise.resolve([{ id: 'created-issue-1' }]);
    },
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectRows.shift() ?? [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
    update: () => {
      updateMock();
      throw new Error('github-adapter issued an UPDATE: this door admits once and updates nothing');
    },
    insert: () => {
      insertMock();
      throw new Error('github-adapter issued an INSERT through drizzle rather than the door');
    },
  },
}));

const admitGithubIssueMock = vi.fn<(projectId: string) => Promise<Record<string, unknown>>>();
const finalizeIntakeMock = vi.fn(async () => undefined);
vi.mock('../issues/intake-gate.js', () => ({
  admitGithubIssue: (projectId: string) => admitGithubIssueMock(projectId),
  finalizeIntake: () => finalizeIntakeMock(),
}));

const applyProjectedEventMock = vi.fn(async () => 1);
const projectedEvents = new Set(['pull_request', 'pull_request_review', 'check_run', 'push']);
vi.mock('../integrations/github/projection-events.js', () => ({
  isProjectedEvent: (eventType: string) => projectedEvents.has(eventType),
  applyProjectedEvent: () => applyProjectedEventMock(),
}));

const infoMock = vi.fn();
const warnMock = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() },
}));

const { handleGitHubEvent } = await import('./github-adapter.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ctx = { projectId: PROJECT, bindingId: 'b-1', config: {}, secrets: {} };

/** The project-creator lookup every `issues` delivery makes before it branches. */
function creatorFound() {
  selectRows.push([{ createdBy: 'user-1' }]);
}

const opened = {
  action: 'opened',
  issue: { id: 7001, title: 'upstream bug', body: 'from GitHub' },
};

beforeEach(() => {
  executed.length = 0;
  selectRows.length = 0;
  updateMock.mockReset();
  insertMock.mockReset();
  admitGithubIssueMock.mockReset();
  finalizeIntakeMock.mockClear();
  applyProjectedEventMock.mockClear();
  infoMock.mockReset();
  warnMock.mockReset();
});

describe('issues.opened — the door decides, not this file', () => {
  it('a closed door writes nothing at all', async () => {
    creatorFound();
    admitGithubIssueMock.mockResolvedValue({ admitted: false, reason: 'github-intake-closed' });

    const r = await handleGitHubEvent(ctx, 'issues', opened);

    expect(r.actions).toBe(0);
    expect(executed).toHaveLength(0);
    expect(finalizeIntakeMock).not.toHaveBeenCalled();
  });

  // cm:guard the refusal is named. Falling through to `unhandled event` would make a project whose door is shut indistinguishable from a webhook that never fired, and one live project loses its arrivals at the default.
  it('a closed door says which door refused, not "unhandled event"', async () => {
    creatorFound();
    admitGithubIssueMock.mockResolvedValue({ admitted: false, reason: 'github-intake-closed' });

    await handleGitHubEvent(ctx, 'issues', opened);

    const messages = infoMock.mock.calls.map((c) => String(c[1]));
    expect(messages).toContain('github-adapter: intake closed, no issue created');
    expect(messages).not.toContain('github-adapter: unhandled event');
    const fields = infoMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.reason).toBe('github-intake-closed');
    expect(fields.externalId).toBe('7001');
  });

  it('an open ungated door inserts once at the status the door named', async () => {
    creatorFound();
    admitGithubIssueMock.mockResolvedValue({ admitted: true, status: 'open', gated: false });

    const r = await handleGitHubEvent(ctx, 'issues', opened);

    expect(r.actions).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('INSERT INTO issues');
    expect(executed[0]).toContain('ON CONFLICT');
    expect(finalizeIntakeMock).not.toHaveBeenCalled();
  });

  it('a gated arrival is finalized so it carries the intake label', async () => {
    creatorFound();
    admitGithubIssueMock.mockResolvedValue({ admitted: true, status: 'draft', gated: true });

    await handleGitHubEvent(ctx, 'issues', opened);

    expect(finalizeIntakeMock).toHaveBeenCalledTimes(1);
  });

  // cm:guard ONE statement, and it is an INSERT. The upsert this replaced ran a SELECT and then either an UPDATE or an INSERT, and the UPDATE arm is what rewrote a title somebody had since corrected here. `db.update` throws in this file's mock so that arm cannot come back quietly.
  it('issues one statement and never an update', async () => {
    creatorFound();
    admitGithubIssueMock.mockResolvedValue({ admitted: true, status: 'open', gated: false });

    await handleGitHubEvent(ctx, 'issues', opened);

    expect(executed).toHaveLength(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('a delivery carrying no issue id writes nothing', async () => {
    creatorFound();
    const r = await handleGitHubEvent(ctx, 'issues', { action: 'opened', issue: {} });
    expect(r.actions).toBe(0);
    expect(executed).toHaveLength(0);
    expect(admitGithubIssueMock).not.toHaveBeenCalled();
  });
});

describe('issues.edited and issues.closed — the door admits once', () => {
  for (const action of ['edited', 'closed'] as const) {
    it(`${action} reaches no statement, so no stored row moves`, async () => {
      creatorFound();
      const r = await handleGitHubEvent(ctx, 'issues', {
        action,
        issue: { id: 7002, title: 'rewritten upstream', body: 'rewritten upstream' },
      });

      expect(r.actions).toBe(0);
      expect(executed).toHaveLength(0);
      expect(updateMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it(`${action} never asks the door, so it cannot create a row for an unknown id`, async () => {
      creatorFound();
      await handleGitHubEvent(ctx, 'issues', { action, issue: { id: 999_999 } });
      expect(admitGithubIssueMock).not.toHaveBeenCalled();
      expect(executed).toHaveLength(0);
    });

    it(`${action} is logged as the door admitting once`, async () => {
      creatorFound();
      await handleGitHubEvent(ctx, 'issues', { action, issue: { id: 7002 } });
      const messages = infoMock.mock.calls.map((c) => String(c[1]));
      expect(messages).toContain(
        'github-adapter: the intake door admits once, so this event writes nothing',
      );
      expect(messages).not.toContain('github-adapter: unhandled event');
    });
  }
});

describe('the projection is reached first (ISS-1062)', () => {
  // cm:guard outcome 5 is enforced by this ORDERING and no longer by the guard below it: a `pull_request` delivery returns into the projection before the issues branch exists. The assertion is that it never reaches the door, not merely that no row appeared.
  for (const eventType of ['pull_request', 'check_run', 'push'] as const) {
    it(`${eventType} goes to the projection and never reaches the issues path`, async () => {
      const r = await handleGitHubEvent(ctx, eventType, {
        action: 'opened',
        issue: { id: 7003, title: 'a PR wearing an issue payload' },
      });

      expect(r.actions).toBe(1);
      expect(applyProjectedEventMock).toHaveBeenCalledTimes(1);
      expect(admitGithubIssueMock).not.toHaveBeenCalled();
      expect(executed).toHaveLength(0);
      expect(selectRows).toHaveLength(0);
    });
  }
});

describe('a project with no creator', () => {
  it('writes nothing and warns', async () => {
    selectRows.push([]);
    const r = await handleGitHubEvent(ctx, 'issues', opened);
    expect(r.actions).toBe(0);
    expect(executed).toHaveLength(0);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

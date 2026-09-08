import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issues } from '../../db/schema.js';
import { makeFakeJobPrincipal } from '../fake-principal.fixture.js';

/**
 * ISS-969: the MCP door is the ONLY one that presents a device token, so
 * `bodyPolicy` fires here and effectively nowhere else — a driver posting
 * through the `forge` CLI or REST holds a person's PAT and is never refused.
 *
 * What this file owns that the integration suite cannot: that the refusal
 * survives the tool's own error frame. `forge_comments` wraps its run in a
 * catch that re-throws a body refusal as `BAD_REQUEST: <code>: <message>`, and
 * a refusal missing from that branch reaches the agent as a bare error — the
 * shape a client reads as a server fault and retries verbatim, forever.
 *
 * Its own file rather than more of `forge-comments.test.ts`, which is already
 * over its size budget; the mock surface is the same narrow one.
 */

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const selectLimit = vi.fn();
// cm:guard `.orderBy()` must be awaitable AND `.limit()`-able, and LAZILY so — the reply query in `listIssueCommentPage` awaits at `orderBy` with no `limit` after it while the root query calls `.limit()` on the same object (ISS-956)
const selectOrderByRows = vi.fn(async (): Promise<unknown[]> => []);
const selectOrderBy = vi.fn(() => ({
  limit: selectLimit,
  then: <R>(onOk: (rows: unknown[]) => R, onErr?: (e: unknown) => R) =>
    selectOrderByRows().then(onOk, onErr),
}));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
// cm:guard branch on the TABLE — `from(issues).innerJoin(projects)` is `insertComment`'s stage read (ISS-969) and nothing else in this path, so it answers off its own row; routed through the shared chain it would eat a `selectLimit` the tests below queued for an auth lookup, and every one of them would resolve one link early.
const stageContextRow: { stage: string; agentConfig: unknown } = {
  stage: 'open',
  agentConfig: null,
};
const selectStageJoin = vi.fn(() => ({
  where: () => ({ limit: async () => [{ ...stageContextRow }] }),
}));
const selectFrom = vi.fn((table: unknown) =>
  table === issues
    ? {
        where: selectWhere,
        innerJoin: selectStageJoin,
        leftJoin: selectLeftJoin,
      }
    : {
        where: selectWhere,
        innerJoin: selectInnerJoin,
        leftJoin: selectLeftJoin,
      },
);
const insertReturning = vi.fn();
const insertValues = vi.fn((_row: Record<string, unknown>) => ({ returning: insertReturning }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../comments/attachment-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../comments/attachment-service.js')>();
  return { ...actual, listCommentAttachmentsForIssue: async () => new Map() };
});

const { forgeCommentsTool } = await import('./forge-comments.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '99999999-9999-4999-8999-99999999bbbb';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };
const jobPrincipal = makeFakeJobPrincipal(DEVICE_ID, OWNER_ID, JOB_ID);

const tool = () => forgeCommentsTool({ principal: jobPrincipal, projectSlug: null });

const OUTCOME_BODY = '<forge-outcome kind="done"><p>shipped</p></forge-outcome>';

// cm:guard TWO reads, not three. `principalAuthorDeviceId` stopped querying for the job's device in ISS-932 wave 4 — it returns `principal.deviceId` — so a third queued row here is consumed by whatever runs next and every later assertion resolves one link early.
function createHits() {
  selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
}

function requireAtOpen(component: string | null): void {
  stageContextRow.agentConfig = component
    ? { pipelineConfig: { states: { open: { bodyPolicy: { requireComponent: component } } } } }
    : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  stageContextRow.stage = 'open';
  requireAtOpen(null);
});

describe('forge_comments under a stage body policy (ISS-969)', () => {
  it('writes a plain body while the project has declared nothing', async () => {
    createHits();
    insertReturning.mockResolvedValueOnce([{ id: 'c1', body: 'prose', format: 'markdown' }]);

    await tool().handler({ action: 'create', data: { issue: ISSUE_ID, body: 'prose' } });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'prose', stage: 'open' }),
    );
  });

  // cm:guard the refusal must keep the `BAD_REQUEST:` frame AND name the component and the stage. `forge-comments.ts`'s catch is what supplies the frame, and a refusal class missing from that branch is invisible here in every other assertion.
  it('refuses a body that omits the component, through the tool error frame', async () => {
    requireAtOpen('forge-outcome');
    createHits();

    await expect(
      tool().handler({ action: 'create', data: { issue: ISSUE_ID, body: 'prose' } }),
    ).rejects.toThrow(/BAD_REQUEST: BODY_COMPONENT_REQUIRED/);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('names the component and the stage in what the agent reads back', async () => {
    requireAtOpen('forge-outcome');
    createHits();

    await expect(
      tool().handler({ action: 'create', data: { issue: ISSUE_ID, body: 'prose' } }),
    ).rejects.toThrow(/forge-outcome/);
  });

  it('writes the same call once it carries the component', async () => {
    requireAtOpen('forge-outcome');
    createHits();
    insertReturning.mockResolvedValueOnce([
      { id: 'c1', body: OUTCOME_BODY, format: 'html', template: 'forge-outcome' },
    ]);

    await tool().handler({
      action: 'create',
      data: { issue: ISSUE_ID, body: OUTCOME_BODY, format: 'html' },
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'forge-outcome', stage: 'open' }),
    );
  });

  // cm:guard a policy that leaked one stage sideways would refuse every comment on the project and read, from the outside, exactly like the intended rule working
  it('writes at a stage the project did not name', async () => {
    requireAtOpen('forge-outcome');
    stageContextRow.stage = 'needs_info';
    createHits();
    insertReturning.mockResolvedValueOnce([{ id: 'c1', body: 'prose', format: 'markdown' }]);

    await tool().handler({ action: 'create', data: { issue: ISSUE_ID, body: 'prose' } });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ stage: 'needs_info' }));
  });
});

import type { Forecast, ForecastPaused, ScopeForecast } from '@forge/contracts/forecast';
import {
  DESIGN_TOOL_ACTIONS,
  DESIGN_TOOL_READS,
  ISSUES_TOOL_ACTIONS,
  QUESTIONS_TOOL_ACTIONS,
  RELEASES_TOOL_ACTIONS,
} from '@forge/contracts/mcp-product';
import { describe, expect, it } from 'vitest';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import type { McpContext, McpTool } from '../lib/tool.js';
import { assertToolDeclaresAccess, toolGrantFor, toolGrantRefusal } from '../lib/tool-grant.js';
import { issueProgress, scopeProgress } from './progress.js';
import {
  forgeDesignTool,
  forgeIssuesTool,
  forgeQuestionsTool,
  forgeReleasesProductTool,
} from './tool.js';

const ctx = {
  principal: {
    kind: 'pat',
    agency: 'human',
    agentUserId: null,
    userId: '00000000-0000-4000-8000-000000000001',
    tokenId: 'tok-1',
    scopes: ['read', 'write'],
    projectIds: null,
    permissions: ['*'],
    grantEpoch: 3,
    boundProjectId: null,
    deviceId: null,
    onBehalfOf: null,
  },
  projectSlug: null,
} as unknown as McpContext;

const tools: Record<string, McpTool> = {
  forge_releases: forgeReleasesProductTool(ctx),
  forge_design: forgeDesignTool(ctx),
  forge_questions: forgeQuestionsTool(ctx),
  forge_issues: forgeIssuesTool(ctx),
};

const actionsOf = (t: McpTool) =>
  (t.inputSchema.properties as { action: { enum: string[] } }).action.enum;

describe('the product tools on /mcp', () => {
  it('each declares a grant, a reach and a route for every action it takes', () => {
    for (const t of Object.values(tools)) expect(() => assertToolDeclaresAccess(t)).not.toThrow();
    expect(actionsOf(tools.forge_releases as McpTool)).toEqual([...RELEASES_TOOL_ACTIONS]);
    expect(actionsOf(tools.forge_design as McpTool)).toEqual([...DESIGN_TOOL_ACTIONS]);
    expect(actionsOf(tools.forge_questions as McpTool)).toEqual([...QUESTIONS_TOOL_ACTIONS]);
    expect(actionsOf(tools.forge_issues as McpTool)).toEqual([...ISSUES_TOOL_ACTIONS]);
  });

  it('reads with a read grant and writes with a write grant, as the routes take them', () => {
    const design = tools.forge_design as McpTool;
    for (const action of DESIGN_TOOL_ACTIONS) {
      const read = (DESIGN_TOOL_READS as readonly string[]).includes(action);
      expect(toolGrantFor(design, { action })).toBe(read ? 'projects:read' : 'projects:write');
    }
    const questions = tools.forge_questions as McpTool;
    expect(toolGrantFor(questions, { action: 'answer' })).toBe('questions:write');
    expect(toolGrantFor(questions, { action: 'ask' })).toBe('issues:write');
    expect(toolGrantFor(tools.forge_issues as McpTool, { action: 'get' })).toBe('issues:read');
  });

  it('refuses a release decision to a token granted only reads, naming the grant it needs', () => {
    const refusal = toolGrantRefusal(
      tools.forge_releases as McpTool,
      { action: 'decide', projectId: 'p', version: '0.1.0', decision: 'approve' },
      ['projects:read'],
    );
    expect(refusal).toContain("forge_releases action 'decide' needs 'projects:write'");
    expect(
      toolGrantRefusal(tools.forge_releases as McpTool, { action: 'list' }, ['projects:read']),
    ).toBeNull();
  });
});

describe('forge_issues create', () => {
  const issues = tools.forge_issues as McpTool;

  async function refusalOf(args: Record<string, unknown>): Promise<RefusalError> {
    const err = await issues.handler(args).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RefusalError);
    return err as RefusalError;
  }

  it('files nothing and says where the record goes instead, and when to step in', async () => {
    const err = await refusalOf({ action: 'create', projectId: ctx.principal.userId });
    expect(isRefusal(err, 'MCP_FILES_FEEDBACK_NOT_ISSUES')).toBe(true);
    const detail = err.refusals[0]?.detail ?? '';
    expect(detail).toContain('An MCP client files no issue');
    expect(detail).toContain('forge_feedback');
    expect(detail).toContain('forge_requirements');
    expect(detail).toContain('forge_design suggestion_accept');
    expect(detail).toContain('forge_questions ask');
    expect(detail).toContain('ask the person before recording anything');
    expect(detail).toContain('never accept a breakdown or a triage on your own');
  });

  it('steers a create carrying any fields, the retired tool’s `data` included', async () => {
    const err = await refusalOf({
      action: 'create',
      data: { title: 'Login is broken', description: 'Safari' },
      title: 'Login is broken',
    });
    expect(isRefusal(err, 'MCP_FILES_FEEDBACK_NOT_ISSUES')).toBe(true);
  });

  it('carries the same steering in the description a client reads before it calls', () => {
    expect(issues.description).toContain('MCP_FILES_FEEDBACK_NOT_ISSUES');
    expect(issues.description).toContain('An MCP client files no issue');
    expect(toolGrantFor(issues, { action: 'create' })).toEqual({
      none: expect.stringContaining('writes nothing'),
    });
  });

  it('refuses an action it does not take by the schema, not by guessing', async () => {
    const err = await issues.handler({ action: 'update', projectId: 'x' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isRefusal(err, 'BAD_REQUEST')).toBe(true);
  });
});

const stamp = { label: 'forecast' as const, asOf: '2026-10-16T00:00:00.000Z' };
const basis = {
  n: 30,
  floor: 10,
  windowDays: 60,
  complexity: null,
  cycleP50Minutes: 60,
  cycleP85Minutes: 120,
  throughputPerDay: 3,
  concurrency: 2,
  concurrencyBasis: 'history',
};
const range = (over: Partial<Extract<Forecast, { kind: 'forecast' }>> = {}): Forecast => ({
  ...stamp,
  kind: 'forecast',
  anchoredAt: stamp.asOf,
  confidence: { level: 'medium', n: 30, spread: 1 },
  p50At: '2026-10-18T10:00:00.000Z',
  p85At: '2026-10-20T10:00:00.000Z',
  p50Minutes: 100,
  p85Minutes: 200,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis,
  late: null,
  ...over,
});
const paused: ForecastPaused = {
  ...stamp,
  kind: 'paused',
  who: 'Minh',
  act: 'approve the design',
  reason: 'its build waits on the approved revision',
  says: {} as ForecastPaused['says'],
  ref: null,
  since: null,
  late: null,
};

describe('progress, as a person reads it', () => {
  it('says an agent is working now and gives the forecast’s dates', () => {
    const p = issueProgress(range(), 'running');
    expect(p.running).toBe(true);
    expect(p.eta).toEqual({
      likelyBy: '2026-10-18T10:00:00.000Z',
      latestBy: '2026-10-20T10:00:00.000Z',
      confidence: 'medium',
    });
    expect(p.says).toBe(
      'An agent is working on it now. Likely done by 2026-10-18, at the latest 2026-10-20 (medium confidence).',
    );
  });

  it('says what goes first where nothing runs yet', () => {
    const p = issueProgress(range({ ahead: 2, aheadKeys: ['ISS-4', 'ISS-5'] }), null);
    expect(p.running).toBe(false);
    expect(p.says).toContain('Not started: 2 issue(s) go first (ISS-4, ISS-5).');
  });

  it('names the person a wait is on and gives no date while it waits', () => {
    const p = issueProgress(paused, null);
    expect(p.eta).toBeNull();
    expect(p.says).toBe(
      'Not running. It waits on Minh to approve the design (its build waits on the approved revision). No date while it waits.',
    );
  });

  it('says plainly there is no ETA where history is too short, and why', () => {
    const p = issueProgress({ ...stamp, kind: 'not_enough_history', n: 4, floor: 10 }, 'queued');
    expect(p.eta).toBeNull();
    expect(p.says).toBe(
      'Queued: an agent picks it up next. No ETA: the forecast needs 10 landed issues to learn from and has 4.',
    );
  });

  it('says done and ended work runs nothing', () => {
    expect(
      issueProgress({ ...stamp, kind: 'landed', landedAt: '2026-10-10T00:00:00.000Z' }, null).says,
    ).toBe('Done: it landed on 2026-10-10. Nothing runs on it.');
    expect(issueProgress({ ...stamp, kind: 'ended', status: 'dropped' }, null).says).toBe(
      'It ended as dropped without landing. Nothing runs on it.',
    );
  });

  it('says it is late once past its latest date', () => {
    const late = range({
      late: { reason: 'p85_passed', since: '2026-10-15T00:00:00.000Z', byMinutes: 180 },
    });
    expect(issueProgress(late, 'running').says).toContain(
      'It is late: past its latest date by about 3 h.',
    );
  });

  it('reads a draft release: how far, who is working, when in hands, and the act after', () => {
    const scope = {
      ...stamp,
      scope: 'release',
      key: '0.2.0',
      progress: { total: 3, shipped: 0, awaitingRelease: 1, toDo: 2 },
      forecast: range(),
      next: { ...paused, who: 'You', act: 'cut the release', reason: 'the project cuts by hand' },
      title: null,
      delivery: {
        ...stamp,
        landing: range(),
        release: null,
        inHands: null,
        shipped: null,
      },
      anchor: { at: stamp.asOf, event: {} },
      moved: null,
    } as unknown as ScopeForecast;
    const p = scopeProgress(scope, ['ISS-7']);
    expect(p.running).toBe(true);
    expect(p.says).toBe(
      '2 of 3 issue(s) still to land, 1 landed and waiting for a release, 0 shipped. ' +
        'An agent is working now on ISS-7. All landed likely by 2026-10-18, at the latest 2026-10-20. ' +
        'Then it waits on You to cut the release (the project cuts by hand).',
    );
  });

  it('reads an empty draft as holding nothing, with no date', () => {
    const scope = {
      progress: { total: 0, shipped: 0, awaitingRelease: 0, toDo: 0 },
      forecast: null,
      next: null,
      delivery: null,
    } as unknown as ScopeForecast;
    expect(scopeProgress(scope, [])).toEqual({
      running: false,
      eta: null,
      says: 'It holds no issue yet, so nothing runs and no date.',
    });
  });
});

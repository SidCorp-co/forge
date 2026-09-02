import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const insertAndEnqueueJob = vi.fn(async (_args: Record<string, unknown>) => ({ jobId: 'job-1' }));
const openIssueRun = vi.fn(async () => ({ id: 'run-1', startedAt: new Date() }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));
vi.mock('./enqueue-helper.js', () => ({
  insertAndEnqueueJob,
  ActiveJobConflictError: class ActiveJobConflictError extends Error {},
}));
vi.mock('./runs.js', () => ({ openIssueRun }));

const { autonomousStepFor, dispatchAutonomous, dispatchDriveManual, isAutonomous } = await import(
  './autonomous-dispatch.js'
);

const ACTOR = { type: 'user', id: 'user-1', agency: 'human' } as const;
const BASE = {
  projectId: 'proj-1',
  issueId: 'issue-1',
  actor: ACTOR,
  projectCreatedBy: 'user-1',
} as const;

beforeEach(() => {
  selectLimit.mockReset();
  insertAndEnqueueJob.mockClear();
  openIssueRun.mockClear();
});

describe('autonomousStepFor', () => {
  it('produces the drive step only at the entry status', () => {
    expect(autonomousStepFor('open')).toEqual({ type: 'drive', skillName: 'forge-drive' });
    for (const status of ['confirmed', 'approved', 'developed', 'testing', 'closed'] as const) {
      expect(autonomousStepFor(status)).toBeNull();
    }
  });
});

describe('isAutonomous', () => {
  it('is false for every project that has not said otherwise', () => {
    expect(isAutonomous(null)).toBe(false);
    expect(isAutonomous({ enabled: true })).toBe(false);
    expect(isAutonomous({ enabled: true, mode: 'staged' })).toBe(false);
    expect(isAutonomous({ enabled: true, mode: 'autonomous' })).toBe(true);
  });
});

describe('dispatchAutonomous', () => {
  it('declines the decision on a staged project so the caller walks its own path', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
      false,
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues exactly one drive job at the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } })).toBe(
      true,
    );

    expect(insertAndEnqueueJob).toHaveBeenCalledTimes(1);
    expect(insertAndEnqueueJob.mock.calls[0]?.[0]).toMatchObject({
      type: 'drive',
      skillName: 'forge-drive',
      pipelineRunId: 'run-1',
      payloadExtras: { mode: 'autonomous' },
    });
  });

  // cm:guard without `stageStatus` on the payload, `resolveStageOverrides` returns EMPTY and the operator's `states.open` deviceIds / disallowedTools / model never reach the one job type that runs unattended for an hour
  it('stamps the entry status so the operator per-state config governs the drive job', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } });

    expect(insertAndEnqueueJob.mock.calls[0]?.[0]?.payloadExtras).toEqual({
      mode: 'autonomous',
      stageStatus: 'open',
    });
  });

  // cm:guard every phase endpoint takes the run as a PATH SEGMENT, so a prompt without it instructs the agent to make a call it cannot form — and the failure looks like the agent ignoring its skill
  it('tells the agent which run it is on, and where its resume point lives', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    expect(prompt).toContain('run-1');
    expect(prompt).toContain('pipeline-runs/run-1/resume-point');
  });

  // cm:guard this prompt and packages/runner/skills/forge-drive/SKILL.md are read in ONE context window, so they must name one transport. They disagreed until 2026-09-02 — the skill said `forge-runner api`, this said `forge_issues` / `forge_config` / `forge_phase` — and the agent believed the prompt: 4,806 `forge_step_start` and 4,268 `forge_step_handoff.write` MCP calls, every one on an autonomous project. The rule is ONE name, not an unreachable tool: the driver's MCP client works, and the job PAT wins because it is minted per job and revoked at terminal where the device token is fleet-wide. The runner-side twin is `bundled_skills.rs`, which bans the same substring in the skill bodies.
  it('names one transport, and the skill already chose the CLI', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    expect([...prompt.matchAll(/forge_[a-z_.]+/g)].map((m) => m[0])).toEqual([]);
  });

  // cm:guard the property the whole branch exists for: falling through at a non-entry status makes the staged resolver report "no skill registered", which pauses the run and comments on the issue every time the agent moves it
  it('owns the decision at every other status, and enqueues nothing there', async () => {
    for (const status of ['confirmed', 'developed', 'testing', 'closed'] as const) {
      expect(await dispatchAutonomous({ ...BASE, status, cfg: { mode: 'autonomous' } })).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  it('does not enqueue when the issue has already moved off the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'in_progress' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } })).toBe(
      true,
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  // cm:guard ISS-141 follow-up — an operator who sets "require a human" on the entry stage got the driver starting anyway: in staged mode these two checks sit BELOW the autonomous branch in `considerEnqueue`, so they never ran for this mode
  it('honours a human gate on the entry stage and enqueues nothing', async () => {
    for (const open of [{ mode: 'manual' }, { enabled: false }] as const) {
      expect(
        await dispatchAutonomous({
          ...BASE,
          status: 'open',
          cfg: { mode: 'autonomous', states: { open } },
        }),
      ).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  // cm:guard the per-step `auto*` toggles name stages this mode does not have; reading one as "may the driver start" would gate the driver on a knob the operator set for something else
  it('starts on an entry stage that is enabled and automatic', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({
      ...BASE,
      status: 'open',
      cfg: { mode: 'autonomous', states: { open: { mode: 'auto', enabled: true } } },
    });

    expect(insertAndEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than inventing an author when the project has no creator', async () => {
    expect(
      await dispatchAutonomous({
        ...BASE,
        actor: { type: 'device', id: 'dev-1', agency: 'agent' },
        projectCreatedBy: null,
        status: 'open',
        cfg: { mode: 'autonomous' },
      }),
    ).toBe(true);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});

describe('dispatchDriveManual', () => {
  // cm:guard `forge-drive` is never in `skill_registrations`, so the staged manual path throws NO_SKILL_REGISTERED here — without this entry point a gated entry stage has no way out but editing the config
  it('starts the driver even though the entry stage is gated to a human', async () => {
    const result = await dispatchDriveManual({ ...BASE, status: 'open' });

    expect(result).toEqual({ jobId: 'job-1', type: 'drive' });
    expect(insertAndEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it('reads no live status, because the human just looked at the issue', async () => {
    await dispatchDriveManual({ ...BASE, status: 'open' });

    expect(selectLimit).not.toHaveBeenCalled();
  });

  it('says where the driver actually starts instead of silently doing nothing', async () => {
    await expect(dispatchDriveManual({ ...BASE, status: 'developed' })).rejects.toThrow(
      'AUTONOMOUS_NOT_AT_ENTRY',
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});

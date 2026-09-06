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
    expect(autonomousStepFor('open')).toEqual({ type: 'drive', skillName: 'issue-flow' });
    for (const status of ['confirmed', 'approved', 'developed', 'testing', 'closed'] as const) {
      expect(autonomousStepFor(status)).toBeNull();
    }
  });
});

describe('isAutonomous', () => {
  // cm:guard `null` and "a config that parsed" are NOT one case, and this is where that is proved. ISS-897 left one lane, so `mode` is gone and the only question left is whether the config could be read at all — `null` is a missing, archived or unparseable project and must answer false, because rewriting parks and cascading children on a project nobody can see is broken is the worse direction.
  it('answers false only for an unreadable config', () => {
    expect(isAutonomous(null)).toBe(false);
    expect(isAutonomous({ enabled: true } as never)).toBe(true);
    expect(isAutonomous({ enabled: false } as never)).toBe(true);
  });
});

describe('dispatchAutonomous', () => {
  // cm:guard the one `false` this function still returns, and the caller relies on it: an unreadable config must produce no job at all rather than a drive session against a project whose settings nobody could parse.
  it('declines the decision when the config could not be read', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: null })).toBe(false);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues exactly one drive job at the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
      true,
    );

    expect(insertAndEnqueueJob).toHaveBeenCalledTimes(1);
    expect(insertAndEnqueueJob.mock.calls[0]?.[0]).toMatchObject({
      type: 'drive',
      skillName: 'issue-flow',
      pipelineRunId: 'run-1',
      payloadExtras: { mode: 'autonomous' },
    });
  });

  // cm:guard without `stageStatus` on the payload, `resolveStageOverrides` returns EMPTY and the operator's `states.open` deviceIds / disallowedTools / model never reach the one job type that runs unattended for an hour
  it('stamps the entry status so the operator per-state config governs the drive job', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } });

    expect(insertAndEnqueueJob.mock.calls[0]?.[0]?.payloadExtras).toEqual({
      mode: 'autonomous',
      stageStatus: 'open',
    });
  });

  // cm:guard every phase endpoint takes the run as a PATH SEGMENT, so a prompt without it instructs the agent to make a call it cannot form — and the failure looks like the agent ignoring its skill
  it('tells the agent which run it is on, and where its resume point lives', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    expect(prompt).toContain('run-1');
    expect(prompt).toContain('pipeline-runs/run-1/resume-point');
  });

  // cm:guard the seed IS the vocabulary — `phase_journal.phase` is free-form and ungated, so the ordinal is caught here or nowhere. 542 rows landed named `phase-0`..`phase-8` between 2026-09-02 and ISS-921 because the example read `phase-1`, and no aggregate over them means anything.
  it('seeds a phase name a reader can interpret, never an ordinal', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    const declared = [...prompt.matchAll(/"phase":"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((p) => /^phase-\d/.test(p ?? ''))).toEqual([]);
    expect(new Set(declared).size).toBe(1);
  });

  // cm:guard this prompt and the `issue-flow` skill (forge-plugin repo) are read in ONE context window, so they must name one transport. They disagreed until 2026-09-02 — the skill said `forge-runner api`, this said `forge_issues` / `forge_config` / `forge_phase` — and the agent believed the prompt: 4,806 `forge_step_start` and 4,268 `forge_step_handoff.write` MCP calls, every one on an autonomous project. The rule is ONE name, not an unreachable tool: the driver's MCP client works, and the job PAT wins because it is minted per job and revoked at terminal where the device token is fleet-wide. The runner-side twin is `bundled_skills.rs`, which bans the same substring in the skill bodies.
  it('names one transport, and the skill already chose the CLI', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    expect([...prompt.matchAll(/forge_[a-z_.]+/g)].map((m) => m[0])).toEqual([]);
  });

  // cm:guard the property the whole branch exists for: falling through at a non-entry status makes the staged resolver report "no skill registered", which pauses the run and comments on the issue every time the agent moves it
  it('owns the decision at every other status, and enqueues nothing there', async () => {
    for (const status of ['confirmed', 'developed', 'testing', 'closed'] as const) {
      expect(await dispatchAutonomous({ ...BASE, status, cfg: { enabled: true } })).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  it('does not enqueue when the issue has already moved off the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'in_progress' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
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
          cfg: { enabled: true, states: { open } },
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
      cfg: { enabled: true, states: { open: { mode: 'auto', enabled: true } } },
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
        cfg: { enabled: true },
      }),
    ).toBe(true);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});

describe('dispatchDriveManual', () => {
  // cm:guard the driver skill is never in `skill_registrations` (it arrives as a plugin), so the staged manual path throws NO_SKILL_REGISTERED here — without this entry point a gated entry stage has no way out but editing the config
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

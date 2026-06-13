import { describe, expect, it, vi } from 'vitest';

// smoke-verify.ts transitively imports db/client (env-validated at import),
// pg-boss (via enqueue-helper) and the runner selector; these pure-function
// tests never touch them, so stub the side-effectful modules.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../pipeline/enqueue-helper.js', () => ({ insertAndEnqueueJob: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({ openOneShotRun: vi.fn() }));
vi.mock('../runners/select.js', () => ({ selectRunnerForJob: vi.fn() }));

const { buildSmokeCanaryPrompt, computeTier1Entries, planSmokeCanaries, summarizeTier2Jobs } =
  await import('./smoke-verify.js');
type SmokeTier1Entry = import('./smoke-verify.js').SmokeTier1Entry;
type SmokeJobRowLite = import('./smoke-verify.js').SmokeJobRowLite;
type StageRegistrationRow = import('./smoke-verify.js').StageRegistrationRow;
type ProjectSkillSyncStatus = import('./effective.js').ProjectSkillSyncStatus;

const { PIPELINE_STEPS } = await import('../pipeline/registry.js');

const NOW = new Date('2026-06-12T10:00:00.000Z');

const DEVICE = {
  deviceId: 'd-1',
  name: 'runner-1',
  status: 'online',
  lastSeenAt: '2026-06-12T09:59:00.000Z',
};

function reg(stage: string, name: string): StageRegistrationRow {
  return { stage, skillId: `id-${name}`, skillName: name, skillScope: 'project' };
}

/** A sync status with one device and one skill entry per given name/status. */
function sync(
  skillEntries: Array<{
    name: string;
    deviceStatus: 'synced' | 'outdated' | 'missing';
    installedHash?: string | null;
    syncedAt?: string | null;
  }>,
  devices = [DEVICE],
): ProjectSkillSyncStatus {
  return {
    devices,
    skills: skillEntries.map((e, i) => ({
      skillId: `id-${e.name}`,
      name: e.name,
      currentVersion: 1,
      effectiveHash: `hash-${i}`,
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        status: e.deviceStatus,
        installedVersion: e.deviceStatus === 'missing' ? null : 1,
        installedHash:
          e.installedHash !== undefined
            ? e.installedHash
            : e.deviceStatus === 'missing'
              ? null
              : e.deviceStatus === 'synced'
                ? `hash-${i}`
                : 'stale-hash',
        syncedAt: e.syncedAt ?? (e.deviceStatus === 'missing' ? null : '2026-06-11T00:00:00Z'),
      })),
    })),
  };
}

function entryFor(entries: SmokeTier1Entry[], stage: string): SmokeTier1Entry {
  const e = entries.find((x) => x.stage === stage);
  if (!e) throw new Error(`no entry for stage ${stage}`);
  return e;
}

describe('computeTier1Entries', () => {
  it('emits one entry per pipeline stage, FAIL not_registered when no registration', () => {
    const entries = computeTier1Entries({ registrations: [], sync: sync([]), now: NOW });
    expect(entries).toHaveLength(PIPELINE_STEPS.length);
    for (const e of entries) {
      expect(e.status).toBe('FAIL');
      expect(e.reason).toBe('not_registered');
      expect(e.skillName).toBeNull();
      expect(e.checkedAt).toBe(NOW.toISOString());
    }
  });

  it('PASS with evidenceAt when a device reports the matching hash', () => {
    const entries = computeTier1Entries({
      registrations: [reg('open', 'forge-triage')],
      sync: sync([
        { name: 'forge-triage', deviceStatus: 'synced', syncedAt: '2026-06-10T00:00:00Z' },
      ]),
      now: NOW,
    });
    const open = entryFor(entries, 'open');
    expect(open.status).toBe('PASS');
    expect(open.reason).toBeNull();
    expect(open.skillName).toBe('forge-triage');
    expect(open.evidenceAt).toBe('2026-06-10T00:00:00Z');
    // Other stages are still honest FAILs.
    expect(entryFor(entries, 'approved').reason).toBe('not_registered');
  });

  it('FAIL no_project_skill when the registered name has no usable project skill', () => {
    // sync.skills only carries usable project-scoped skills; the registered
    // name missing from it = unadopted global / deleted skill.
    const entries = computeTier1Entries({
      registrations: [{ ...reg('open', 'forge-triage'), skillScope: 'global' }],
      sync: sync([]),
      now: NOW,
    });
    expect(entryFor(entries, 'open').reason).toBe('no_project_skill');
    expect(entryFor(entries, 'open').status).toBe('FAIL');
  });

  it('FAIL no_bound_runner when the project has no runner devices', () => {
    const entries = computeTier1Entries({
      registrations: [reg('open', 'forge-triage')],
      // No bound devices → the skill entry has no per-device rows either.
      sync: sync([{ name: 'forge-triage', deviceStatus: 'synced' }], []),
      now: NOW,
    });
    expect(entryFor(entries, 'open').reason).toBe('no_bound_runner');
  });

  it('FAIL stale_on_runner when every reporting device has a differing hash', () => {
    const entries = computeTier1Entries({
      registrations: [reg('open', 'forge-triage')],
      sync: sync([{ name: 'forge-triage', deviceStatus: 'outdated' }]),
      now: NOW,
    });
    const open = entryFor(entries, 'open');
    expect(open.status).toBe('FAIL');
    expect(open.reason).toBe('stale_on_runner');
  });

  it('FAIL no_device_report (not a green) when no device ever reported an install', () => {
    const entries = computeTier1Entries({
      registrations: [reg('open', 'forge-triage')],
      sync: sync([{ name: 'forge-triage', deviceStatus: 'missing' }]),
      now: NOW,
    });
    const open = entryFor(entries, 'open');
    expect(open.status).toBe('FAIL');
    expect(open.reason).toBe('no_device_report');
  });
});

describe('summarizeTier2Jobs', () => {
  const row = (over: Partial<SmokeJobRowLite> & { stage?: string }): SmokeJobRowLite => ({
    id: over.id ?? 'j-1',
    status: over.status ?? 'done',
    error: over.error ?? null,
    failureReason: over.failureReason ?? null,
    payload: { smoke: true, smokeStage: over.stage ?? 'open' },
    queuedAt: over.queuedAt ?? '2026-06-12T09:00:00Z',
    finishedAt: over.finishedAt !== undefined ? over.finishedAt : '2026-06-12T09:05:00Z',
  });

  it('maps done→PASS, failed/cancelled→FAIL with reason, active→PENDING', () => {
    const out = summarizeTier2Jobs([
      row({ id: 'j-1', stage: 'open', status: 'done' }),
      row({ id: 'j-2', stage: 'approved', status: 'failed', error: 'preflight_failed: repo' }),
      row({ id: 'j-3', stage: 'testing', status: 'running', finishedAt: null }),
    ]);
    expect(out.map((e) => [e.stage, e.status])).toEqual([
      ['open', 'PASS'],
      ['approved', 'FAIL'],
      ['testing', 'PENDING'],
    ]);
    expect(out[0]?.checkedAt).toBe('2026-06-12T09:05:00Z');
    expect(out[1]?.reason).toBe('preflight_failed: repo');
    expect(out[2]?.checkedAt).toBeNull();
  });

  it('keeps only the newest job per stage (rows arrive newest-first)', () => {
    const out = summarizeTier2Jobs([
      row({ id: 'j-new', stage: 'open', status: 'failed', failureReason: 'broken' }),
      row({ id: 'j-old', stage: 'open', status: 'done' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.jobId).toBe('j-new');
    expect(out[0]?.status).toBe('FAIL');
    expect(out[0]?.reason).toBe('broken');
  });

  it('ignores rows without a smokeStage payload', () => {
    expect(summarizeTier2Jobs([{ ...row({}), payload: {} }])).toEqual([]);
  });
});

describe('planSmokeCanaries', () => {
  const tier1 = (over: Partial<SmokeTier1Entry>): SmokeTier1Entry => ({
    stage: 'open',
    jobType: 'triage',
    skillId: 'id-forge-triage',
    skillName: 'forge-triage',
    status: 'PASS',
    reason: null,
    detail: null,
    checkedAt: NOW.toISOString(),
    evidenceAt: null,
    ...over,
  });

  it('dispatches registered stages, skips unregistered + already-active ones', () => {
    const plan = planSmokeCanaries({
      tier1: [
        tier1({ stage: 'open' }),
        tier1({
          stage: 'approved',
          skillId: null,
          skillName: null,
          status: 'FAIL',
          reason: 'not_registered',
        }),
        tier1({ stage: 'testing', skillName: 'forge-test', skillId: 'id-forge-test' }),
      ],
      activeStages: new Set(['testing']),
    });
    expect(plan.toDispatch).toEqual([{ stage: 'open', skillName: 'forge-triage' }]);
    expect(plan.skipped).toEqual([
      { stage: 'approved', reason: 'not_registered' },
      { stage: 'testing', reason: 'canary_already_active' },
    ]);
  });

  it('a disk-FAIL stage still gets a canary (the canary IS the evidence)', () => {
    const plan = planSmokeCanaries({
      tier1: [tier1({ status: 'FAIL', reason: 'no_device_report' })],
      activeStages: new Set(),
    });
    expect(plan.toDispatch).toEqual([{ stage: 'open', skillName: 'forge-triage' }]);
  });

  it('narrows to the requested stages', () => {
    const plan = planSmokeCanaries({
      tier1: [tier1({ stage: 'open' }), tier1({ stage: 'testing', skillName: 'forge-test' })],
      activeStages: new Set(),
      stages: ['testing'],
    });
    expect(plan.toDispatch).toEqual([{ stage: 'testing', skillName: 'forge-test' }]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('buildSmokeCanaryPrompt', () => {
  it('names the skill path + stage and forbids mutation', () => {
    const p = buildSmokeCanaryPrompt('forge-code', 'approved');
    expect(p).toContain('.claude/skills/forge-code/SKILL.md');
    expect(p).toContain("'approved' pipeline stage");
    expect(p).toContain('Do NOT modify the repository');
    expect(p).toContain('SMOKE_VERIFY_OK forge-code');
    expect(p).toContain('SMOKE_VERIFY_MISSING forge-code');
  });
});

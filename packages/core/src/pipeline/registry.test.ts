import {
  pipelineRegistryResponseSchema,
  REGISTRY_BACKLOG_ADMISSIBLE_STATUSES,
  REGISTRY_ISSUE_COMPLEXITIES,
  REGISTRY_ISSUE_PRIORITIES,
  REGISTRY_ISSUE_STATUSES,
  REGISTRY_JOB_TYPES,
  REGISTRY_PIPELINE_RUN_KINDS,
  REGISTRY_PIPELINE_RUN_STATUSES,
  REGISTRY_RUNNER_TYPES,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  type JobType,
  jobTypes,
  pipelineRunKinds,
  pipelineRunStatuses,
  runnerTypes,
} from '../db/schema.js';
import { BACKLOG_ADMISSIBLE_STATUSES } from './autonomous-mode.js';
import { getPipelineRegistry, PIPELINE_REGISTRY_VERSION, RUNNER_CAPABILITIES } from './registry.js';
import { transitions } from './state-machine.js';

const STAGED_JOB_TYPES: readonly JobType[] = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'staging',
  'fix',
  'release',
];

describe('contracts ↔ core enum parity', () => {
  // cm:guard the settings screen offers exactly this tuple as checkboxes. Drift it and an operator picks a status `poolBacklogSchema` then rejects, and the refusal names zod rather than the mistake.
  it('REGISTRY_BACKLOG_ADMISSIBLE_STATUSES mirrors core BACKLOG_ADMISSIBLE_STATUSES', () => {
    expect([...REGISTRY_BACKLOG_ADMISSIBLE_STATUSES]).toEqual([...BACKLOG_ADMISSIBLE_STATUSES]);
  });

  it('REGISTRY_ISSUE_STATUSES mirrors core issueStatuses', () => {
    expect([...REGISTRY_ISSUE_STATUSES]).toEqual([...issueStatuses]);
  });

  it('REGISTRY_JOB_TYPES mirrors core jobTypes', () => {
    expect([...REGISTRY_JOB_TYPES]).toEqual([...jobTypes]);
  });

  it('REGISTRY_RUNNER_TYPES mirrors core runnerTypes', () => {
    expect([...REGISTRY_RUNNER_TYPES]).toEqual([...runnerTypes]);
  });

  it('REGISTRY_ISSUE_PRIORITIES mirrors core issuePriorities', () => {
    expect([...REGISTRY_ISSUE_PRIORITIES]).toEqual([...issuePriorities]);
  });

  it('REGISTRY_ISSUE_COMPLEXITIES mirrors core issueComplexities', () => {
    expect([...REGISTRY_ISSUE_COMPLEXITIES]).toEqual([...issueComplexities]);
  });

  it('REGISTRY_PIPELINE_RUN_STATUSES mirrors core pipelineRunStatuses', () => {
    expect([...REGISTRY_PIPELINE_RUN_STATUSES]).toEqual([...pipelineRunStatuses]);
  });

  it('REGISTRY_PIPELINE_RUN_KINDS mirrors core pipelineRunKinds', () => {
    expect([...REGISTRY_PIPELINE_RUN_KINDS]).toEqual([...pipelineRunKinds]);
  });
});

describe('getPipelineRegistry()', () => {
  it('returns the three-key payload at version 7', () => {
    const payload = getPipelineRegistry();
    expect(payload.version).toBe(PIPELINE_REGISTRY_VERSION);
    expect(payload.version).toBe(7);
    expect(payload.runnerCapabilities).toBe(RUNNER_CAPABILITIES);
    expect(Object.keys(payload).sort()).toEqual(['runnerCapabilities', 'statusExits', 'version']);
  });

  it('parses cleanly against the @forge/contracts schema', () => {
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    const parsed = pipelineRegistryResponseSchema.parse(json);
    expect(parsed.version).toBe(7);
  });

  // cm:guard the picker offers a rung exactly the row it reads here, so a status absent from this map is a status whose menu is EMPTY in the UI — the shape `dropped` has on purpose and no other rung may acquire by omission (ISS-982)
  it('serves an exits row for every issue status and no other key', () => {
    const { statusExits } = getPipelineRegistry();
    expect(Object.keys(statusExits).sort()).toEqual([...issueStatuses].sort());
  });

  it('serves each row exactly as state-machine declares it, order included', () => {
    const { statusExits } = getPipelineRegistry();
    for (const s of issueStatuses) {
      expect(statusExits[s]).toEqual(transitions[s]);
    }
  });

  it('rejects a payload missing a status, which the key-set check above would otherwise pass', () => {
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    delete json.statusExits.dropped;
    expect(Object.keys(json.statusExits).sort()).not.toEqual([...issueStatuses].sort());
  });

  it('rejects a row that is shape-valid and wrong', () => {
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    json.statusExits.closed = ['open'];
    expect(pipelineRegistryResponseSchema.safeParse(json).success).toBe(true);
    expect(json.statusExits.closed).not.toEqual(transitions.closed);
  });

  // cm:guard both directions of the version-7 rollout, which is what lets the two halves deploy in either order (ISS-982): a client on the old schema must accept the new payload, and this schema must accept a response from a core that predates `statusExits`.
  it('parses a response from a core that sends no statusExits', () => {
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    json.version = 6;
    delete json.statusExits;
    const parsed = pipelineRegistryResponseSchema.parse(json);
    expect(parsed.statusExits).toBeUndefined();
  });

  it('parses the new payload against a schema shaped as the one clients held before it', () => {
    const beforeThisChange = z.object({
      version: z.number().int().positive(),
      runnerCapabilities: z.record(
        z.enum(REGISTRY_RUNNER_TYPES),
        z.array(z.enum(REGISTRY_JOB_TYPES)),
      ),
    });
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    const parsed = beforeThisChange.parse(json);
    expect(parsed.version).toBe(7);
    expect('statusExits' in parsed).toBe(false);
  });
});

describe('GET /api/pipeline/registry', () => {
  it('returns 200 with a body that parses via pipelineRegistryResponseSchema', async () => {
    const { Hono } = await import('hono');
    const { pipelineRegistryRoutes } = await import('./registry-routes.js');

    const app = new Hono();
    app.route('/api/pipeline/registry', pipelineRegistryRoutes);

    const res = await app.fetch(new Request('http://localhost/api/pipeline/registry'));
    expect(res.status).toBe(200);

    const parsed = pipelineRegistryResponseSchema.parse(await res.json());
    expect(parsed.version).toBe(7);
    expect(parsed.statusExits?.closed).toEqual(['reopen']);
    expect(parsed.statusExits?.dropped).toEqual([]);
    expect(parsed.runnerCapabilities['claude-code']).toEqual([
      'drive',
      'smoke',
      'release_batch',
      'reconcile',
      'verify_skill',
    ]);
  });
});

describe('RUNNER_CAPABILITIES', () => {
  // cm:guard this is the ONLY check on the array contents — `RUNNER_CAPABILITIES` is a Record keyed by runner type, so TypeScript verifies the two KEYS and never the lists inside them. `drive` was absent for the whole of phase 3 and every dispatch failed `runner_unsupported_type`, permanently, with no runner ever selected.
  it('every job type is claimable by some runner, or explicitly unenqueueable', () => {
    // cm:why `pm` bypasses the gate entirely (own queue) and `custom` is operator-defined with no canonical runner — every other non-staged type reaches `runnerSupportsJobType` and must be claimable
    const EXEMPT: readonly JobType[] = ['pm', 'custom'];
    const claimable = new Set(Object.values(RUNNER_CAPABILITIES).flat());
    const orphans = jobTypes.filter(
      (t) => !claimable.has(t) && !EXEMPT.includes(t) && !STAGED_JOB_TYPES.includes(t),
    );
    expect(orphans).toEqual([]);
  });

  // cm:guard the staged types stay OUT, and this is what says so. They survive in `jobTypes` because ~30k historical `jobs` rows hold them and a read of one must stay representable (ISS-895); absence here is the whole mechanism that makes them unenqueueable — a runner handed one fails it `runner_unsupported_type`, which is the loud refusal. Adding one back silently re-opens a lane whose skills, step table and dispatch gate no longer exist.
  it('no staged job type is claimable by any runner', () => {
    const claimable = new Set(Object.values(RUNNER_CAPABILITIES).flat());
    expect(STAGED_JOB_TYPES.filter((t) => claimable.has(t))).toEqual([]);
  });

  // cm:edge contract -> packages/core/src/pipeline/autonomous-mode.ts — AUTONOMOUS_JOB_TYPE; spelled literally because importing that module pulls in db/client.js, which validates env at import and would make this hermetic suite need a database
  it('the autonomous driver runs on claude-code', () => {
    expect(RUNNER_CAPABILITIES['claude-code']).toContain('drive');
  });
});

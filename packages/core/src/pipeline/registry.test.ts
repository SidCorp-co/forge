import {
  pipelineRegistryResponseSchema,
  REGISTRY_ISSUE_COMPLEXITIES,
  REGISTRY_ISSUE_PRIORITIES,
  REGISTRY_ISSUE_STATUSES,
  REGISTRY_JOB_TYPES,
  REGISTRY_PIPELINE_RUN_KINDS,
  REGISTRY_PIPELINE_RUN_STATUSES,
  REGISTRY_RUNNER_TYPES,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
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
import { getPipelineRegistry, PIPELINE_REGISTRY_VERSION, RUNNER_CAPABILITIES } from './registry.js';

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
  it('returns the two-key payload at version 6', () => {
    const payload = getPipelineRegistry();
    expect(payload.version).toBe(PIPELINE_REGISTRY_VERSION);
    expect(payload.version).toBe(6);
    expect(payload.runnerCapabilities).toBe(RUNNER_CAPABILITIES);
    expect(Object.keys(payload).sort()).toEqual(['runnerCapabilities', 'version']);
  });

  it('parses cleanly against the @forge/contracts schema', () => {
    const json = JSON.parse(JSON.stringify(getPipelineRegistry()));
    const parsed = pipelineRegistryResponseSchema.parse(json);
    expect(parsed.version).toBe(6);
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
    expect(parsed.version).toBe(6);
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

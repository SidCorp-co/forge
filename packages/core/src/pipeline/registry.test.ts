import {
  REGISTRY_ISSUE_STATUSES,
  REGISTRY_JOB_TYPES,
  REGISTRY_RUNNER_TYPES,
  REGISTRY_STEP_TOGGLE_KEYS,
  pipelineRegistryResponseSchema,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { issueStatuses, jobTypes, runnerTypes } from '../db/schema.js';
import { STEP_TOGGLE_KEYS } from './pipeline-config-schema.js';
import {
  MANUAL_ONLY_JOB_TYPES,
  PIPELINE_REGISTRY_VERSION,
  PIPELINE_STEPS,
  RUNNER_CAPABILITIES,
  STATUS_TO_JOB_TYPE,
  STATUS_TO_SKILL,
  WORKING_STATUS_BY_JOB_TYPE,
  getPipelineRegistry,
} from './registry.js';
import { transitions } from './state-machine.js';
import { STATUS_TO_JOB_TYPE as MAPPING_RE_EXPORT } from './skill-mapping.js';

describe('PIPELINE_STEPS literal sanity', () => {
  it('skillName always follows the forge-${jobType} convention', () => {
    for (const step of PIPELINE_STEPS) {
      expect(step.skillName).toBe(`forge-${step.jobType}`);
    }
  });

  it('has the nine automatable steps in the expected order', () => {
    expect(PIPELINE_STEPS.map((s) => s.status)).toEqual([
      'open',
      'confirmed',
      'clarified',
      'approved',
      'developed',
      'testing',
      'pass',
      'reopen',
      'released',
    ]);
  });

  it('clarify sits on the happy path: confirmed → clarify, clarified → plan', () => {
    expect(STATUS_TO_JOB_TYPE['confirmed']?.type).toBe('clarify');
    expect(STATUS_TO_JOB_TYPE['clarified']?.type).toBe('plan');
    // needs_info is a human-gated bounce state — nothing dispatches there.
    expect(STATUS_TO_JOB_TYPE['needs_info']).toBeUndefined();
  });

  it('MANUAL_ONLY_JOB_TYPES is empty after clarify promotion (ISS-171)', () => {
    expect(MANUAL_ONLY_JOB_TYPES).toEqual([]);
    const types = PIPELINE_STEPS.map((s) => s.jobType);
    expect(types).toContain('clarify');
  });
});

describe('PIPELINE_STEPS enum parity', () => {
  it('every step.status is a known IssueStatus', () => {
    for (const step of PIPELINE_STEPS) {
      expect(issueStatuses).toContain(step.status);
    }
  });

  it('every step.jobType is a known JobType', () => {
    for (const step of PIPELINE_STEPS) {
      expect(jobTypes).toContain(step.jobType);
    }
  });

  it('every step.toggle is in STEP_TOGGLE_KEYS', () => {
    for (const step of PIPELINE_STEPS) {
      expect(STEP_TOGGLE_KEYS).toContain(step.toggle);
    }
  });
});

describe('derivation parity', () => {
  it('skill-mapping re-exports the same STATUS_TO_JOB_TYPE instance', () => {
    expect(MAPPING_RE_EXPORT).toBe(STATUS_TO_JOB_TYPE);
  });

  it('STATUS_TO_JOB_TYPE matches PIPELINE_STEPS row-for-row', () => {
    for (const step of PIPELINE_STEPS) {
      expect(STATUS_TO_JOB_TYPE[step.status]).toEqual({
        type: step.jobType,
        toggle: step.toggle,
      });
    }
    expect(Object.keys(STATUS_TO_JOB_TYPE).sort()).toEqual(
      PIPELINE_STEPS.map((s) => s.status).sort(),
    );
  });

  it('STATUS_TO_SKILL matches PIPELINE_STEPS row-for-row', () => {
    for (const step of PIPELINE_STEPS) {
      expect(STATUS_TO_SKILL[step.status]).toBe(step.skillName);
    }
  });

  it('STEP_TOGGLE_KEYS equals PIPELINE_STEPS.map(s => s.toggle)', () => {
    expect([...STEP_TOGGLE_KEYS]).toEqual(PIPELINE_STEPS.map((s) => s.toggle));
  });
});

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

  it('REGISTRY_STEP_TOGGLE_KEYS mirrors PIPELINE_STEPS toggles', () => {
    expect([...REGISTRY_STEP_TOGGLE_KEYS]).toEqual(PIPELINE_STEPS.map((s) => s.toggle));
  });
});

describe('getPipelineRegistry()', () => {
  it('returns the four-key payload with version 4', () => {
    const payload = getPipelineRegistry();
    expect(payload.version).toBe(PIPELINE_REGISTRY_VERSION);
    expect(payload.version).toBe(4);
    expect(payload.steps).toBe(PIPELINE_STEPS);
    expect(payload.runnerCapabilities).toBe(RUNNER_CAPABILITIES);
    expect(payload.manualOnlyJobTypes).toBe(MANUAL_ONLY_JOB_TYPES);
  });

  it('parses cleanly against the @forge/contracts schema', () => {
    const payload = getPipelineRegistry();
    const json = JSON.parse(JSON.stringify(payload));
    const parsed = pipelineRegistryResponseSchema.parse(json);
    expect(parsed.version).toBe(4);
    expect(parsed.steps).toHaveLength(9);
    expect(parsed.manualOnlyJobTypes).toEqual([]);
  });
});

describe('workingStatus (registry v3, sparse by design)', () => {
  it('only code + fix flip to an in-flight status; both reuse in_progress', () => {
    const withWorking = PIPELINE_STEPS.filter((s) => s.workingStatus !== null);
    expect(withWorking.map((s) => s.jobType).sort()).toEqual(['code', 'fix']);
    for (const step of withWorking) expect(step.workingStatus).toBe('in_progress');
  });

  it('workingStatus never equals the trigger status and is a known IssueStatus', () => {
    for (const step of PIPELINE_STEPS) {
      if (step.workingStatus === null) continue;
      expect(step.workingStatus).not.toBe(step.status);
      expect(issueStatuses).toContain(step.workingStatus);
    }
  });

  it('the strict transition matrix allows trigger → working for every pair', () => {
    for (const step of PIPELINE_STEPS) {
      if (step.workingStatus === null) continue;
      expect(transitions[step.status]).toContain(step.workingStatus);
    }
  });

  it('WORKING_STATUS_BY_JOB_TYPE derives from PIPELINE_STEPS', () => {
    expect(WORKING_STATUS_BY_JOB_TYPE).toEqual({ code: 'in_progress', fix: 'in_progress' });
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

    const body = await res.json();
    const parsed = pipelineRegistryResponseSchema.parse(body);
    expect(parsed.steps).toHaveLength(9);
    expect(parsed.version).toBe(4);
    expect(parsed.manualOnlyJobTypes).toEqual([]);
    expect(parsed.runnerCapabilities['claude-code']).toEqual([
      'plan',
      'code',
      'review',
      'fix',
      'triage',
      'test',
      'staging',
      'release',
      'clarify',
      'smoke',
    ]);
  });
});

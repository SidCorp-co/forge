import { describe, expect, it } from 'vitest';
import {
  pipelineRegistryResponseSchema,
  REGISTRY_ISSUE_STATUSES,
  REGISTRY_JOB_TYPES,
  REGISTRY_RUNNER_TYPES,
  REGISTRY_STEP_TOGGLE_KEYS,
} from '@forge/contracts';
import { issueStatuses, jobTypes, runnerTypes } from '../db/schema.js';
import {
  MANUAL_ONLY_JOB_TYPES,
  PIPELINE_REGISTRY_VERSION,
  PIPELINE_STEPS,
  RUNNER_CAPABILITIES,
  STATUS_TO_JOB_TYPE,
  STATUS_TO_SKILL,
  getPipelineRegistry,
} from './registry.js';
import { STATUS_TO_JOB_TYPE as MAPPING_RE_EXPORT } from './skill-mapping.js';
import { STEP_TOGGLE_KEYS } from './pipeline-config-schema.js';

describe('PIPELINE_STEPS literal sanity', () => {
  it('skillName always follows the forge-${jobType} convention', () => {
    for (const step of PIPELINE_STEPS) {
      expect(step.skillName).toBe(`forge-${step.jobType}`);
    }
  });

  it('has the seven automatable steps in the expected order', () => {
    expect(PIPELINE_STEPS.map((s) => s.status)).toEqual([
      'open',
      'confirmed',
      'approved',
      'developed',
      'testing',
      'reopen',
      'released',
    ]);
  });

  it('clarify is manual-only and absent from PIPELINE_STEPS', () => {
    expect(MANUAL_ONLY_JOB_TYPES).toEqual(['clarify']);
    for (const step of PIPELINE_STEPS) {
      expect(step.jobType).not.toBe('clarify');
    }
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
  it('returns the four-key payload with version 1', () => {
    const payload = getPipelineRegistry();
    expect(payload.version).toBe(PIPELINE_REGISTRY_VERSION);
    expect(payload.version).toBe(1);
    expect(payload.steps).toBe(PIPELINE_STEPS);
    expect(payload.runnerCapabilities).toBe(RUNNER_CAPABILITIES);
    expect(payload.manualOnlyJobTypes).toBe(MANUAL_ONLY_JOB_TYPES);
  });

  it('parses cleanly against the @forge/contracts schema', () => {
    const payload = getPipelineRegistry();
    const json = JSON.parse(JSON.stringify(payload));
    const parsed = pipelineRegistryResponseSchema.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.steps).toHaveLength(7);
    expect(parsed.manualOnlyJobTypes).toEqual(['clarify']);
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
    expect(parsed.steps).toHaveLength(7);
    expect(parsed.version).toBe(1);
    expect(parsed.manualOnlyJobTypes).toEqual(['clarify']);
    expect(parsed.runnerCapabilities['claude-code']).toEqual([
      'plan',
      'code',
      'review',
      'fix',
      'triage',
      'test',
      'release',
    ]);
  });
});

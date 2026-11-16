// `steward.budget` is retired (ISS-1255): the steward's runner jobs take the box's run slots and a
// per-item runaway guard replaced its turn cap. A write naming the budget is refused by name, saying
// what replaced it, never parsed and ignored; `steward.enabled` stays.

import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { checkProjectConfig } from './rules.js';
import { projectDocumentSchema } from './schema.js';

const ID = '11111111-1111-4111-8111-111111111111';

const parse = (steward: unknown) =>
  projectDocumentSchema.safeParse({
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: ID, slug: 'demo', name: 'Demo' },
    source: {
      type: 'git',
      git: { repository: 'github.com/o/r', defaultBranch: 'main', branches: ['main'] },
    },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: {
      prod: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    promotions: [],
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
    ...(steward === undefined ? {} : { steward }),
  });

const ctx = { bindings: new Map(), testingProfileIds: new Set<string>() };

function refusalsOf(steward: unknown) {
  const parsed = parse(steward);
  if (!parsed.success) throw new Error(`the document must parse: ${parsed.error.message}`);
  return checkProjectConfig(parsed.data, ctx);
}

describe('steward.budget is retired', () => {
  it('refuses a budget by name, saying the run slots and the runaway guard replaced it', () => {
    for (const budget of [{ runnerJobs: 3 }, { gatewayTurns: 0, runnerJobs: 0 }, {}]) {
      const refusals = refusalsOf({ enabled: true, budget });
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        code: 'STEWARD_BUDGET_RETIRED',
        path: '/steward/budget',
      });
      expect(refusals[0]?.detail).toContain('run slots');
      expect(refusals[0]?.detail).toContain('runaway guard');
    }
  });

  it('refuses a budget not even in the old shape with the same reason, never a bare type error', () => {
    for (const budget of [5, 'lots', { runnerJobs: 99.5 }, { jobs: 2 }]) {
      const parsed = parse({ budget });
      expect(parsed.success, `${JSON.stringify(budget)} must be refused`).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('steward.budget is retired');
    }
  });

  it('keeps enabled, absent being on, and refuses nothing without a budget', () => {
    for (const steward of [undefined, {}, { enabled: false }, { enabled: true }]) {
      expect(refusalsOf(steward)).toEqual([]);
    }
  });
});

import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { projectDocumentSchema } from './schema.js';

const ID = '11111111-1111-4111-8111-111111111111';

const withFeedback = (feedback: unknown) =>
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
      prod: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
      },
    },
    promotions: [],
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
    feedback,
  });

describe('feedback.verifyWindowDays: how long a resolved item waits before Forge verifies it', () => {
  it('takes a whole number of days inside the bounds, and none at all', () => {
    expect(withFeedback({ verifyWindowDays: 7 }).success).toBe(true);
    expect(withFeedback({ verifyWindowDays: 1 }).success).toBe(true);
    expect(withFeedback({ verifyWindowDays: 90 }).success).toBe(true);
    expect(withFeedback(undefined).success).toBe(true);
  });

  it('refuses 0, a negative, a fraction and an absurd window, naming the field', () => {
    for (const bad of [0, -3, 2.5, 91, 3650]) {
      const r = withFeedback({ verifyWindowDays: bad });
      expect(r.success, `${bad} must be refused`).toBe(false);
      const text = JSON.stringify(r.error?.issues);
      expect(text).toContain('feedback.verifyWindowDays');
      expect(text).toContain('verifyWindowDays');
    }
  });

  it('refuses a key it does not know, rather than ignoring a misspelt window', () => {
    expect(withFeedback({ verifyWindow: 7 }).success).toBe(false);
  });
});

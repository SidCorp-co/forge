/**
 * Where two environments deploy the branch a judged issue landed on, a declared run's read names the
 * one whose testing profile it asks for, and stays refused by name where none or both name it
 * (ISS-788: forge's own `dev` and `demo` both deploy `dev`, and the ISS-538 judge, run ee85679a on
 * 2026-11-02, was refused TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS though only `dev` names the profile
 * it asked for). Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import {
  codeOf,
  declaredRun,
  landedIssue,
  secrets,
  seedDeclaredRunWorld,
  VALUE,
  world,
} from '../helpers/declared-run-secrets-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

beforeEach(seedDeclaredRunWorld);

describe('where two environments deploy the branch the work landed on', () => {
  const twoEnvironments = (demoTesting: string | null) =>
    seedProjectDocument(world.projectId, world.ownerId, {
      defaultBranch: 'main',
      promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
      environments: {
        stg: {
          tier: 'staging',
          deploysFrom: 'release/stg',
          deployment: { mode: 'external' },
          testing: 'stg',
        },
        demo: {
          tier: 'staging',
          deploysFrom: 'release/stg',
          deployment: { mode: 'external' },
          ...(demoTesting ? { testing: demoTesting } : {}),
        },
      },
    });

  it('answers the one of them that names the profile the run asks for', async () => {
    await twoEnvironments(null);
    await landedIssue(world.projectId, 81);
    const run = await declaredRun(world.projectId, 81);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'stg', profileId: 'stg' });
  });

  it('refuses by name where both name that profile, listing each with its profile', async () => {
    await twoEnvironments('stg');
    await landedIssue(world.projectId, 82);
    const run = await declaredRun(world.projectId, 82);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS');
    expect(JSON.stringify(res.body)).toContain('2 of them name testing profile `stg`');
    expect(JSON.stringify(res.body)).not.toContain(VALUE);
  });
});

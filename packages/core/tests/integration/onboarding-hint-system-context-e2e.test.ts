/**
 * The onboarding hint tells the truth about a project's system context (e2e D9, ISS-63): with no
 * onboarding row, a project holding an approved `system-context` design gets no "No system context
 * yet." hint, one holding only an unapproved one is told it waits on approval, and one holding
 * none is offered onboarding. A design on another template is not a system context.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

let harness: TestDatabase;
let read: typeof import('../../src/onboarding/read.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  read = await import('../../src/onboarding/read.js');
}, 60_000);

afterAll(async () => {
  await harness?.cleanup();
});

async function projectWith(designs: Array<{ template: string; status: string | null }>) {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  for (const [i, d] of designs.entries()) {
    const doc = { version: 2, flow: `design-${i}`, template: { id: d.template, version: 1 } };
    await harness.db.execute(sql`
      INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document,
                                     design_status, approved_revision, written_by_user)
      VALUES (${randomUUID()}, ${project.id}, ${`design-${i}`}, 'flow', 'designed', 1,
              ${JSON.stringify(doc)}::jsonb, ${d.status}, ${d.status === 'approved' ? 1 : null},
              ${owner.id})
    `);
  }
  return { owner, project };
}

describe('the onboarding hint reads the system-context design', () => {
  it('an approved system context: no hint, never "No system context yet."', async () => {
    const w = await projectWith([
      { template: 'system-context', status: 'approved' },
      { template: 'system-context', status: 'proposed' },
    ]);
    const state = await read.readOnboardingState(w.project.id, w.owner.id);
    expect(state.onboarding).toBeNull();
    expect(state.hint).toBeNull();
  });

  it('only an unapproved system context: the hint says it waits on approval', async () => {
    const w = await projectWith([{ template: 'system-context', status: 'proposed' }]);
    const state = await read.readOnboardingState(w.project.id, w.owner.id);
    expect(state.hint).toMatchObject({ lead: 'System context not approved yet.', action: 'start' });
  });

  it('no system-context design, even beside an approved journey: onboarding is offered', async () => {
    const w = await projectWith([{ template: 'operational-flow', status: 'approved' }]);
    const state = await read.readOnboardingState(w.project.id, w.owner.id);
    expect(state.hint).toMatchObject({ lead: 'No system context yet.', action: 'start' });
  });
});

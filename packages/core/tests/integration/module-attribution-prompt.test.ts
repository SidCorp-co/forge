/**
 * ISS-595 — the module taxonomy reaching a pipeline agent's system prompt, against a real
 * Postgres.
 *
 * The unit suite proves the gate from a hand-built `ProjectFactInputs`. What it cannot prove is
 * the half between a `labels` row and that struct: the self-join that resolves a parent's name,
 * the `kind='module'` predicate, and the project scoping. A reader that leaked plain labels or
 * another project's modules would inject the section into every project on the deployment, and
 * a mocked client answers whatever the mock was told to.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  loadProjectFactInputs: typeof import('../../src/prompt/facts/resolve.js')['loadProjectFactInputs'];
  renderStageFactsText: typeof import('../../src/prompt/facts/resolve.js')['renderStageFactsText'];
};

let harness: TestDatabase;
let mods: Mods;
let user: { id: string };
let project: { id: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const resolveMod = await import('../../src/prompt/facts/resolve.js');
  mods = {
    loadProjectFactInputs: resolveMod.loadProjectFactInputs,
    renderStageFactsText: resolveMod.renderStageFactsText,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  user = await createTestUser(harness.db);
  project = await createTestProject(harness.db, user.id);
});

async function insertLabel(
  projectId: string,
  name: string,
  kind: 'label' | 'module',
  parentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, parent_id)
    VALUES (${id}, ${projectId}, ${name}, '#1f6f4a', ${kind}, ${parentId})
  `);
  return id;
}

const promptFor = async (projectId: string) =>
  mods.renderStageFactsText(await mods.loadProjectFactInputs(projectId), projectId, 'drive');

describe('ISS-595 · the taxonomy reaches the prompt', () => {
  it('names each module and its parent, and no plain label', async () => {
    const billing = await insertLabel(project.id, 'billing', 'module');
    await insertLabel(project.id, 'invoices', 'module', billing);
    // cm:why a name that appears nowhere in the fact's own example payload, so the assertion below fails on a leaked plain label rather than on the instruction text quoting one
    await insertLabel(project.id, 'wontfix-ux', 'label');

    const text = await promptFor(project.id);
    expect(text).toContain("### The issue's primary module");
    expect(text).toContain('- billing');
    expect(text).toContain('- invoices (under billing)');
    expect(text).not.toContain('wontfix-ux');
  });

  it('tells the agent the field, not a comment line', async () => {
    await insertLabel(project.id, 'billing', 'module');
    const text = await promptFor(project.id);
    expect(text).toContain('isPrimary: true');
    expect(text).toContain('forge_issues.update');
    expect(text).toContain('is NOT the attribution and nothing reads it');
  });

  // cm:guard the whole no-op claim rests on THIS case: a project that keeps only plain labels
  // must get no section, or every project on the deployment is told to attribute to nothing
  it('adds nothing for a project whose labels are all plain', async () => {
    await insertLabel(project.id, 'wontfix-ux', 'label');
    await insertLabel(project.id, 'bug', 'label');
    const text = await promptFor(project.id);
    expect(text).not.toContain("### The issue's primary module");
    expect(text).not.toContain('isPrimary');
  });

  it("does not leak another project's modules", async () => {
    await insertLabel(project.id, 'billing', 'module');
    const other = await createTestProject(harness.db, user.id);
    const text = await promptFor(other.id);
    expect(text).not.toContain("### The issue's primary module");
  });
});

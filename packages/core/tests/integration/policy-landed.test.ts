import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why before the stage ① producer existed, `policy.landed` had a reader and no writer, so assembleBundle item 11 was permanently empty and the verifier's hard constraint was always null
describe('policy.landed sweep (stage ①)', () => {
  let harness: TestDatabase;
  let schema: typeof import('../../src/db/schema.js');
  let sweepPolicyLanded: typeof import('../../src/skills/policy-landed.js').sweepPolicyLanded;
  let projectId: string;

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
    schema = await import('../../src/db/schema.js');
    ({ sweepPolicyLanded } = await import('../../src/skills/policy-landed.js'));
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    projectId = project.id;
  });

  async function policyEvents() {
    return harness.db
      .select()
      .from(schema.skillActivityEvents)
      .where(
        and(
          eq(schema.skillActivityEvents.eventType, 'policy.landed'),
          eq(schema.skillActivityEvents.projectId, projectId),
        ),
      );
  }

  it('stamps every project on first run, with a digest and a readable summary', async () => {
    const result = await sweepPolicyLanded();
    expect(result.projectsStamped).toBeGreaterThanOrEqual(1);

    const [event] = await policyEvents();
    expect(event?.afterHash).toBe(result.digest);
    expect(event?.beforeHash).toBeNull();
    expect(event?.reason).toContain('platform invariant(s) in force');
    expect(event?.deltaSummary).toContain('initial snapshot');
    expect(event?.actor).toBe('system:seeder');
    expect(event?.trigger).toBe('deploy');
  });

  // cm:why §7 principle 1 — the log records transitions, not passes, so a boot that changes nothing must write nothing or every deploy floods the feed
  it('is idempotent: a second sweep with an unchanged invariant set writes nothing', async () => {
    await sweepPolicyLanded();
    const afterFirst = await policyEvents();

    const second = await sweepPolicyLanded();
    const afterSecond = await policyEvents();

    expect(second.projectsStamped).toBe(0);
    expect(second.changed).toBe(false);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });

  it('fills assembleBundle item 11, which was permanently empty before', async () => {
    await sweepPolicyLanded();

    const [event] = await policyEvents();
    // cm:why this is the exact shape assembleBundle reads for the bundle's `invariantSet`
    expect(event).toMatchObject({
      reason: expect.stringContaining('in force'),
      deltaSummary: expect.any(String),
    });
    expect(event?.occurredAt).toBeInstanceOf(Date);
  });
});

/**
 * ISS-1372 — one role deploys, cancels and rolls back a Coolify binding, whichever door it comes in
 * by.
 *
 * `forge_coolify_deploy` needs the project writer role for all three. The REST routes resolved the
 * caller's role and then let a viewer through, so a person who could only read a project could
 * start a production deploy. The refusal comes before any binding is read, which is why no
 * binding is seeded here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Caller, callRest, callTool, type Role, seedRoles } from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let callers: Record<Role, Caller>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  callers = seeded.callers;
});

const ACTIONS = ['deploy', 'cancel', 'rollback'] as const;

// What an empty body earns once the role check has passed: deploy takes none, the others name a missing field.
const PAST_THE_ROLE_CHECK = { deploy: 200, cancel: 400, rollback: 400 } as const;

describe.each(ACTIONS)('Coolify %s', (action) => {
  it('is refused to a viewer at the REST route, by name', async () => {
    const res = await callRest(
      server.baseUrl,
      callers.viewer.jwt,
      'POST',
      `/api/projects/${projectId}/integrations/coolify/${action}`,
      {},
    );
    expect(res.status).toBe(403);
    expect(res.refused).toContain('requires the project member role');
  });

  it('is refused to a viewer at the tool', async () => {
    const { refused } = await callTool(callers.viewer.pat, 'forge_coolify_deploy', {
      action,
      projectId,
    });
    expect(refused).toContain('requires the project member role');
  });

  it.each(['member', 'admin'] as const)(
    'is not refused to a project %s at the REST route',
    async (role) => {
      const res = await callRest(
        server.baseUrl,
        callers[role].jwt,
        'POST',
        `/api/projects/${projectId}/integrations/coolify/${action}`,
        {},
      );
      expect(
        res.status,
        'the role check passed, so the answer is the body check, not a refusal',
      ).toBe(PAST_THE_ROLE_CHECK[action]);
    },
  );
});

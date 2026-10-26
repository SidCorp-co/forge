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

// What an empty body earns once the role check has passed on a project with no Coolify: each is
// refused naming what is missing (ISS-1421 r30: deploy answered 200 and did nothing).
const PAST_THE_ROLE_CHECK = { deploy: 400, cancel: 400, rollback: 400 } as const;

// The same sentence at both doors, naming the act and who may take it (ISS-1421 r30).
const REFUSED = {
  deploy: 'deploy it through Coolify',
  cancel: 'cancel a Coolify deploy for it',
  rollback: 'roll it back through Coolify',
} as const;
const refusal = (action: (typeof ACTIONS)[number]) =>
  `You are a viewer of this project, so you cannot ${REFUSED[action]}. Only a member or admin of this project can, so ask one of them.`;

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
    expect(res.refused).toContain(refusal(action));
  });

  it('is refused to a viewer at the tool', async () => {
    const { refused } = await callTool(callers.viewer.pat, 'forge_coolify_deploy', {
      action,
      projectId,
    });
    expect(refused).toContain(refusal(action));
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
        'the role check passed, so what answers is the body or the missing Coolify, not the role',
      ).toBe(PAST_THE_ROLE_CHECK[action]);
    },
  );
});

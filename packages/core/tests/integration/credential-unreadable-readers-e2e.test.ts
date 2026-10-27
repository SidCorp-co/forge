/**
 * Every reader that holds a binding names it when the credential behind it cannot be decrypted
 * (ISS-1259 r2): a connection shared by several projects otherwise does not say whose binding met it.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import {
  expectNamed,
  expectNothingSecret,
  type PlantedProvider,
  type PlantOptions,
  plantUnreadable,
} from '../helpers/unreadable-credential-fixture.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

let harness: TestDatabase;
let app: Hono<AppVars>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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
  await registerIntegrationsForTest();

  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  const { speakerLinkProjectRoutes } = await import('../../src/assistant/identity/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api', speakerLinkProjectRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let userId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  userId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
});

const plant = (provider: PlantedProvider, opts?: PlantOptions) =>
  plantUnreadable(harness.db, { userId, projectId }, provider, opts);

const headers = async () => ({
  authorization: `Bearer ${await signUserToken(userId)}`,
  'content-type': 'application/json',
});

describe('a reader that holds the binding names it', () => {
  async function unreadableRaised(run: () => Promise<unknown>) {
    const { CredentialUnreadable } = await import(
      '../../src/integrations/credential-unreadable.js'
    );
    const thrown = await run().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(CredentialUnreadable);
    return thrown as InstanceType<typeof CredentialUnreadable>;
  }

  function expectBindingNamed(
    err: { message: string; credential: { bindingId?: string } },
    planted: { connectionId: string; bindingId: string; sealed: Buffer },
  ) {
    expect(err.credential.bindingId).toBe(planted.bindingId);
    expect(err.message).toContain(
      `(connection ${planted.connectionId}, read for a project through integration ${planted.bindingId})`,
    );
    expect(err.message).toContain('Enter the credential again');
    expectNothingSecret(err.message, planted.sealed);
  }

  it('refuses the speaker-link proposal 409 naming the Rocket.Chat binding', async () => {
    const planted = await plant('rocketchat', { config: { serverUrl: 'http://127.0.0.1:9' } });
    const res = await app.request(`/api/projects/${projectId}/speaker-links/proposals`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ source: 'rocketchat', externalId: 'made-up-speaker' }),
    });
    expect(res.status).toBe(409);
    const refusal = (await res.json()) as Refusal;
    expect(refusal.code).toBe('CREDENTIAL_UNREADABLE');
    expectNamed(refusal.message, 'Rocket.Chat', [planted.connectionId, planted.bindingId]);
    expect(refusal.details).toMatchObject({ bindingId: planted.bindingId });
    expectNothingSecret(JSON.stringify(refusal), planted.sealed);
  });

  it('names the binding to the Rocket.Chat room a reply is delivered to', async () => {
    const planted = await plant('rocketchat', {
      config: { serverUrl: 'http://127.0.0.1:9' },
      bindingConfig: { rids: ['made-up-room'] },
    });
    const { rocketChatConversationPorts, rocketChatVenueId } = await import(
      '../../src/integrations/rocketchat/conversation-port.js'
    );
    const venue = {
      adapter: 'rocketchat' as const,
      externalId: rocketChatVenueId('127.0.0.1:9', 'made-up-room'),
      shape: 'channel' as const,
      projectId,
    };
    const err = await unreadableRaised(() =>
      rocketChatConversationPorts.deliver(venue as never, { text: 'made-up reply' } as never),
    );
    expectBindingNamed(err, planted);
  });

  it("names the binding to the agent's GitHub client", async () => {
    const planted = await plant('github', {
      bindingConfig: { owner: 'acme', repo: 'desk', installationId: 1 },
      agentAccess: 'all',
    });
    const { githubAgentClient } = await import('../../src/integrations/github/agent-client.js');
    expectBindingNamed(await unreadableRaised(() => githubAgentClient(projectId)), planted);
  });

  it("names the binding to the project's GitHub repository client", async () => {
    const planted = await plant('github', {
      bindingConfig: { owner: 'acme', repo: 'desk', installationId: 1 },
    });
    const { githubRepoClient } = await import('../../src/integrations/github/client.js');
    expectBindingNamed(await unreadableRaised(() => githubRepoClient(projectId)), planted);
  });

  it('names the binding a pull request was stored under', async () => {
    const planted = await plant('github', {
      bindingConfig: { owner: 'acme', repo: 'desk', installationId: 1 },
    });
    const { githubBindingCredential } = await import(
      '../../src/integrations/github/binding-credential.js'
    );
    expectBindingNamed(
      await unreadableRaised(() => githubBindingCredential(planted.bindingId)),
      planted,
    );
  });

  it("names the binding to a runner box's git credential", async () => {
    const planted = await plant('github', {
      bindingConfig: { owner: 'acme', repo: 'desk', installationId: 1 },
    });
    const device = await createTestDevice(harness.db, userId);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, status, name)
      VALUES (gen_random_uuid(), ${projectId}, 'claude-code', ${device.id}, 'online', 'made-up-runner')
    `);
    const { mintGitCredentialForDevice } = await import('../../src/git/github-app-credential.js');
    expectBindingNamed(
      await unreadableRaised(() =>
        mintGitCredentialForDevice({
          deviceId: device.id,
          host: 'github.com',
          path: 'acme/desk.git',
        }),
      ),
      planted,
    );
  });

  it('names the binding to the Google Sheets tool', async () => {
    const planted = await plant('google', { agentAccess: 'all' });
    const { googleSheetsInfo } = await import('../../src/integrations/google/commands.js');
    expectBindingNamed(
      await unreadableRaised(() =>
        googleSheetsInfo({ projectId, spreadsheetId: 'made-up-spreadsheet' }),
      ),
      planted,
    );
  });

  it('names the binding to the storefront target tool, rather than reading as a failed live query', async () => {
    const planted = await plant('epodsystem', { bindingConfig: { storeId: 'made-up-store' } });
    const { forgeStorefrontTargetTool } = await import(
      '../../src/mcp/tools/forge-storefront-target.js'
    );
    const tool = forgeStorefrontTargetTool({ principal: { kind: 'user', userId } } as never);
    expectBindingNamed(await unreadableRaised(() => tool.handler({ projectId } as never)), planted);
  });

  it('names the binding in what the MCP resolver logs as it skips the server', async () => {
    const planted = await plant('epodsystem', { agentAccess: 'all' });
    const { logger } = await import('../../src/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    try {
      const { resolveGrantedMcpEntries } = await import('../../src/integrations/mcp-resolver.js');
      expect(await resolveGrantedMcpEntries(projectId)).toEqual({});
      const logged = warn.mock.calls
        .map(([fields]) => (fields as { err?: unknown }).err)
        .find((err) => err instanceof Error && err.name === 'CredentialUnreadable');
      expect(logged).toBeDefined();
      expectBindingNamed(logged as never, planted);
    } finally {
      warn.mockRestore();
    }
  });
});

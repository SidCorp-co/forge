/**
 * An org-owned GitHub App bound by several projects — forge-dev's fea7dc5e, serving forge, gwork,
 * forge-plugin and orbit with its one hook at forge's door — routes a verified delivery by the
 * repository it names, whichever of those projects' doors it reached, and each binding reads the
 * door its App calls as its own (ISS-1194).
 *
 * @direct-test-of packages/core/src/integration-door/webhook-inbound-routes.ts
 * @direct-test-of packages/core/src/integrations/github/app-deliveries.ts
 * @direct-test-of packages/core/src/integrations/github/agent-client.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboundWebhookUrl, resolveApiBaseUrl } from '../../src/integrations/index.js';
import { encryptSecret } from '../../src/integrations/vault.js';
import { api } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import {
  bind,
  bindingIdOf,
  deliver,
  deliveriesOf,
  installations,
  orgOwnedApp,
  seedGithubWorld,
  stubGitHub,
  target,
} from '../helpers/github-instance-world.js';

let admin = '';
let session = '';
let project = { id: '', slug: '', orgId: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  ({ admin, session, project } = await seedGithubWorld());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an org-owned App serving several projects routes by the repository it names, at any of their doors (ISS-1194)', () => {
  const INSTALLATION = 171606736;

  /** fea7dc5e as forge-dev holds it: org-owned, one installation, forge's and gwork's repositories bound, its hook at forge's door. */
  async function sharedOrgApp() {
    stubGitHub();
    const connection = await orgOwnedApp(project.orgId);
    expect((await bind(session, connection, project.id, INSTALLATION)).status).toBe(200);
    const secondOwner = (await createTestUser({ verified: true })).id;
    const second = await createTestProject(secondOwner, { orgId: project.orgId });
    await addProjectMember(second.id, admin, 'owner');
    const res = await api(session, 'POST', `/api/integration-connections/${connection}/bindings`, {
      bindings: [
        {
          projectId: second.id,
          role: 'service',
          target: { ...target(INSTALLATION), repo: 'gwork' },
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      connection,
      first: await bindingIdOf(project.id),
      second: { projectId: second.id, binding: await bindingIdOf(second.id) },
    };
  }

  const push = (repository: string) => ({
    ref: 'refs/heads/main',
    installation: { id: INSTALLATION },
    repository: { full_name: repository },
  });

  it('PLANT: a push naming the second project’s repository, delivered at the first project’s door, reaches the second binding and reads healthy there', async () => {
    const { connection, first, second } = await sharedOrgApp();
    const firstDoor = inboundWebhookUrl(resolveApiBaseUrl() as string, project.slug);
    // what the probe stores once it has read the App's hook, and what it stores of each binding
    await rows(sql`
      UPDATE integration_connections
         SET inbound_endpoint_observed = ${JSON.stringify({ url: firstDoor, active: true, observedAt: new Date().toISOString() })}::jsonb,
             last_health_status = 'ok'
       WHERE id = ${connection} RETURNING id`);
    await rows(sql`
      INSERT INTO integration_binding_health (binding_id, status, checked_at)
      VALUES (${first}, 'ok', now()), (${second.binding}, 'ok', now())
      ON CONFLICT (binding_id) DO UPDATE SET status = 'ok', detail = NULL, says = NULL
      RETURNING binding_id`);

    const res = await deliver(`/api/webhooks/in/${project.slug}`, 'push', push('SidCorp-co/gwork'));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'routed', failed: 0 });
    expect(await deliveriesOf(second.binding)).toEqual([
      { status: 'ok', event_name: 'push.unknown' },
    ]);
    expect(await deliveriesOf(first)).toEqual([]);

    const source = await api(
      session,
      'GET',
      `/api/projects/${second.projectId}/integrations/source`,
    );
    expect(source.status, JSON.stringify(source.body)).toBe(200);
    const [report] = source.body.bindings as Array<{
      bindingId: string;
      lastHealthStatus: string | null;
      inboundDoor: string;
      expectedWebhookUrl: string | null;
      inboundDeliveries: number;
    }>;
    expect(report).toMatchObject({
      bindingId: second.binding,
      lastHealthStatus: 'ok',
      inboundDoor: 'open',
      expectedWebhookUrl: firstDoor,
      inboundDeliveries: 1,
    });
  });

  it('a push naming the first project’s own repository still lands on the first binding alone', async () => {
    const { first, second } = await sharedOrgApp();

    const res = await deliver(`/api/webhooks/in/${project.slug}`, 'push', push('SidCorp-co/forge'));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await deliveriesOf(first)).toEqual([{ status: 'ok', event_name: 'push.unknown' }]);
    expect(await deliveriesOf(second.binding)).toEqual([]);
  });

  it('PLANT: a delivery signed with a secret only the door’s binding holds, not the App’s, is never routed to another project', async () => {
    const { first, second } = await sharedOrgApp();
    await rows(sql`
      UPDATE integration_bindings SET integration_secret_enc = ${encryptSecret('whsec-a-stale-copy')}
       WHERE id = ${first} RETURNING id`);

    const res = await deliver(
      `/api/webhooks/in/${project.slug}`,
      'push',
      push('SidCorp-co/gwork'),
      'whsec-a-stale-copy',
    );

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('WEBHOOK_FOREIGN_REPOSITORY');
    expect(await deliveriesOf(second.binding)).toEqual([]);
  });

  it('refuses a delivery the App’s secret does not sign, reaching neither binding', async () => {
    const { first, second } = await sharedOrgApp();

    const res = await deliver(
      `/api/webhooks/in/${project.slug}`,
      'push',
      push('SidCorp-co/gwork'),
      'not-the-secret',
    );

    expect(res.status).toBe(401);
    for (const binding of [first, second.binding]) {
      expect((await deliveriesOf(binding)).filter((d) => d.status !== 'refused')).toEqual([]);
    }
  });

  it('records no installation state for an org-owned App: that ledger is the instance App’s', async () => {
    await sharedOrgApp();

    const res = await deliver(`/api/webhooks/in/${project.slug}`, 'installation', {
      action: 'deleted',
      installation: { id: INSTALLATION, account: { login: 'SidCorp-co' } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'dropped' });
    expect(await installations()).toEqual([]);
  });
});

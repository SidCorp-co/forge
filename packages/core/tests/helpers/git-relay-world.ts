// A project whose source is a GitLab repository bound through a connection holding its token, and a
// box running it at the first runner release that reaches GitLab through Forge's relay (REQ-73 BC-5).
// Its own file, so a change to it selects only the relay's tests.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { PRE_RELAY_RUNNER_AMNESTY } from '../../src/integrations/source-host/host-credential.js';
import { encryptJson } from '../../src/integrations/vault.js';
import { createTestDevice, createTestProject, createTestUser, truncateAll } from './factories.js';
import { seedProjectDocument } from './release-world.js';

export const TOKEN = 'glpat-the-connections-own-token';
export const HOST = 'gitlab.test';
export const REPO = 'acme/canawan-api';

export interface RelayWorld {
  projectId: string;
  deviceId: string;
  boxToken: string;
  bindingId: string;
  connectionId: string;
}

/** Seeds the world afresh; the box's runner waits for its checkout, as a fresh assignment is born. */
export async function seedRelayWorld(): Promise<RelayWorld> {
  await truncateAll();
  const owner = (await createTestUser({ verified: true })).id;
  const projectId = (await createTestProject(owner)).id;
  await seedProjectDocument(projectId, owner, {
    environments: {},
    source: {
      type: 'git',
      git: { repository: `${HOST}/${REPO}`, defaultBranch: 'main', branches: ['main'] },
    },
  });
  const deviceId = await createTestDevice(owner, { agentVersion: PRE_RELAY_RUNNER_AMNESTY });
  await db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status, repo_path, provision_status, provision_requested_at)
    VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'hub box', 'claude-code', 'online',
            '/srv/checkout', 'queued', now())
  `);
  const boxToken = (await mintPat({ permissions: ['*'], userId: owner, name: 'box', deviceId }))
    .plaintext;
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config, secrets_enc)
    VALUES (${connectionId}, 'user', ${owner}, 'gitlab', true,
            ${JSON.stringify({ baseUrl: `https://${HOST}` })}::jsonb, ${encryptJson({ token: TOKEN })})
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${bindingId}, ${connectionId}, ${projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: REPO })}::jsonb)
  `);
  return { projectId, deviceId, boxToken, bindingId, connectionId };
}

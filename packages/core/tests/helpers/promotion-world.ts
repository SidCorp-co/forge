// The promotion release's world (REQ-63 BC-9..12, adminhub-api 2026-10-29): production deployed outside
// Forge from `release/production`, one promotion into it from `release/stg`, a GitLab source binding,
// and issues landed on `release/stg` waiting at the gate. Shared by the promotion release e2e files.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { api, userToken } from './api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from './factories.js';
import { seedProjectDocument } from './release-world.js';

export const STG = 'release/stg';
export const PROD = 'release/production';
export const HEAD = 'a1'.repeat(20);
export const MERGE = 'b2'.repeat(20);
export const DEPLOYED = 'c3'.repeat(20);
export const LANDED = ['d4'.repeat(20), 'e5'.repeat(20)];
const NOTE = { section: 'Added', title: 'Site writes', userFacing: 'A site writes through.' };

export const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
export const rows = async <T>(q: ReturnType<typeof sql>) => [...(await db.execute(q))] as T[];
export const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);
export const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

export async function seedPromotionWorld(
  environment: Record<string, unknown>,
  delivery: Record<string, unknown> = { verdictsRequired: false },
) {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: { production: environment as never },
    promotions: [{ from: STG, to: PROD, via: 'merge' } as never],
    defaultBranch: STG,
    source: {
      type: 'git',
      git: {
        repository: 'gitlab.com/acme/adminhub-api',
        defaultBranch: STG,
        branches: [STG, PROD],
      },
    },
    extra: { delivery } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/adminhub-api' })}::jsonb)`);
}

export const EXTERNAL = {
  tier: 'production',
  deploysFrom: PROD,
  deployment: { mode: 'external' },
  url: 'https://adminhub-api.example.test',
};

/** Issues whose merge requests already merged into release/stg, waiting at the release gate. */
export async function landedIssues(shas: readonly string[] = LANDED, after = 0): Promise<string[]> {
  const ids: string[] = [];
  for (const [n, sha] of shas.entries()) {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                          merged_at, merged_commit_sha, merged_target)
      VALUES (${id}, ${world.projectId}, ${after + n + 1}, ${`issue ${after + n + 1}`}, 'in_progress', ${world.ownerId},
              ${JSON.stringify(NOTE)}::jsonb, now() - interval '1 hour', ${sha}, ${STG})`);
    await seedIssueStatus(id, 'awaiting_release');
    ids.push(id);
  }
  return ids;
}

/** The promotion merge request as GitLab's hook writes it into the projection. */
export async function promotionRequest(number: number, head: string, from = STG, into = PROD) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: 'Promote release/stg to production',
        body: null,
        html_url: `https://gitlab.com/acme/adminhub-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: from, sha: head },
        base: { ref: into, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/adminhub-api' },
    },
  );
}

/**
 * `release/stg` recorded holding `sha`: a feature request merged into it at that commit, as GitLab's
 * hook projects it. A branch cut from release/stg to pin that head carries release/stg (adminhub-fe
 * !2055); a request from a branch holding no such head is not the promotion (ISS-1001, !5066).
 */
let held = 4000;
export async function heldOnSource(sha: string) {
  held += 1;
  const number = held;
  await promotionRequest(number, 'c9'.repeat(20), `feat/held-${number}`, STG);
  await db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${sha}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);
}

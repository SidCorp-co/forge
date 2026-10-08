/**
 * REQ-27 BC-4: a token granted Full can do everything its owner's role can, approvals included (the
 * owner's ruling of 2026-10-08, ADR 0007 amendment). A named grant still holds only what it names,
 * and no grant reaches token management: `/api/pat` stays session-only, so a token cannot widen
 * itself.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import type { StatedPatGrant } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { personalAccessTokens } from '../../src/db/schema.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let say: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const tokens: Record<string, string> = {};

async function token(who: string, permissions: StatedPatGrant): Promise<void> {
  tokens[who] = (
    await mintPat({ permissions, userId: ownerId, name: `bc4-${who}`, projectIds: null })
  ).plaintext;
}

/** A breakdown proposed on an agreed requirement: a suggestion only a holder of suggestions.approve decides. */
async function proposedSuggestion(): Promise<string> {
  const key = ok(
    await say('session', 'POST', at('/requirements'), {
      title: 'A full token decides',
      reason: 'the owner ruled that Full is full',
      criteria: [{ body: 'A Full token rejects a suggestion.' }],
    }),
    201,
  ).key as string;
  ok(await say('session', 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  ok(
    await say('session', 'POST', at(`/requirements/${key}/revisions/1/accept`), {
      reason: 'BA review',
    }),
  );
  ok(
    await say('session', 'POST', at(`/requirements/${key}/agree`), {
      revision: 1,
      reason: 'owner signed r1',
    }),
  );
  const proposed = ok(
    await say('session', 'POST', at('/suggestions'), {
      kind: 'breakdown',
      requirement: key,
      baseRevision: 1,
      payload: {
        issues: [
          {
            title: 'Decide by token',
            criteria: [{ body: 'a full token rejects', tracesTo: 'BC-1' }],
            complexity: 's',
            builds: null,
          },
        ],
      },
    }),
    201,
  );
  return (proposed.suggestion as { id: string }).id;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.session = await signUserToken(ownerId);
  await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${ownerId}`);
  await token('full', ['*']);
  await token('named', ['projects:write']);
  await token('namedApprover', ['projects:write', 'suggestions.approve']);
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a Full token decides what its owner may decide (REQ-27 BC-4)', () => {
  let suggestion = '';
  beforeAll(async () => {
    suggestion = await proposedSuggestion();
  });

  it('a named grant that does not name suggestions.approve is refused PERMISSION_FORBIDDEN', async () => {
    const res = await say('named', 'POST', at(`/suggestions/${suggestion}/reject`), {
      reason: 'not this slice',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(res.json?.code).toBe('PERMISSION_FORBIDDEN');
    expect(String(res.json?.detail)).toContain('suggestions.approve');
    expect(String(res.json?.detail)).toContain(
      'A named token grant holds suggestions.approve only where it names it',
    );
  });

  it('a Full token of an admin rejects the suggestion', async () => {
    const res = await say('full', 'POST', at(`/suggestions/${suggestion}/reject`), {
      reason: 'the owner decides by token',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const listed = ok(await say('session', 'GET', at('/suggestions?status=rejected')));
    expect((listed.suggestions as { id: string }[]).map((s) => s.id)).toContain(suggestion);
  });

  it('a named grant that names suggestions.approve decides as well', async () => {
    const next = await proposedSuggestion();
    const res = await say('namedApprover', 'POST', at(`/suggestions/${next}/reject`), {
      reason: 'named on purpose',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });
});

describe('what no grant reaches', () => {
  it('a Full token is refused token management, reading or minting', async () => {
    const read = await say('full', 'GET', '/api/pat');
    expect(read.status, JSON.stringify(read.json)).toBe(403);
    expect(read.json?.code).toBe('PAT_NOT_PERMITTED');
    const mint = await say('full', 'POST', '/api/pat', { name: 'wider', permissions: ['*'] });
    expect(mint.status, JSON.stringify(mint.json)).toBe(403);
    expect(mint.json?.code).toBe('PAT_NOT_PERMITTED');
  });
});

describe('the mint door', () => {
  it('lists the approvals a named grant may pick', async () => {
    const menu = ok(await say('session', 'GET', '/api/pat')).menu as { explicit: string[] };
    expect(menu.explicit).toContain('suggestions.approve');
  });

  it('refuses a name beside Full that Full already holds, naming why', async () => {
    const res = await say('session', 'POST', '/api/pat', {
      name: 'redundant',
      permissions: ['*', 'suggestions.approve'],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json?.code).toBe('PAT_PERMISSIONS_FULL_NOT_COMBINABLE');
    expect(JSON.stringify(res.json)).toContain('already holds suggestions.approve');
  });
});

describe('a credential core mints for an agent', () => {
  it('is full, naming beside it only the observer key its membership grants, and follows a grant change', async () => {
    const { agentCredentialGrant } = await import('../../src/permissions/index.js');
    const { changeProjectMember } = await import('../../src/projects/service.js');
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(projectId, agent, 'member');
    await changeProjectMember(projectId, agent, { grants: ['suggestions.approve'] });
    expect(await agentCredentialGrant(agent)).toEqual(['*']);
    const minted = await mintPat({
      permissions: await agentCredentialGrant(agent),
      userId: agent,
      name: 'bc4-agent',
      projectIds: [projectId],
    });
    await changeProjectMember(projectId, agent, {
      grants: ['suggestions.approve', 'workflow-observations.write'],
    });
    expect(await agentCredentialGrant(agent)).toEqual(['*', 'workflow-observations.write']);
    const [row] = await db
      .select({ permissions: personalAccessTokens.permissions })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, minted.row.id));
    expect(row?.permissions).toEqual(['*', 'workflow-observations.write']);
  });
});

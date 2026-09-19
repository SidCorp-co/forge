/**
 * ISS-1093 — "was this write an agent or a person" is answered by the CREDENTIAL.
 *
 * Every assertion here goes through `app.request` with a real credential, and that
 * is the whole point of the file. The defect was never in the label function: it
 * was that the label was computed from `issues.created_via`, a constant each DOOR
 * stamps on itself. A test that builds the actor by hand proves the label and says
 * nothing about the door the real request comes through — the two doors here are a
 * session JWT and a PAT, and they are the only things that separate the cases.
 *
 * Postgres is real because the backfill, the filter and the NULL semantics are all
 * things the DATABASE does; a mocked row carries whatever the test typed into it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let accounts: typeof import('../../src/orgs/agent-accounts.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ mintPat } = await import('../../src/auth/pat.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  accounts = await import('../../src/orgs/agent-accounts.js');
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let orgId: string;
let personId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${personId}`);
  const project = await createTestProject(harness.db, personId);
  projectId = project.id;
  orgId = project.orgId;
  // `seedOrg` (via `createTestProject`) already enrols the creator; promote rather
  // than insert a second row over the (org_id, user_id) primary key.
  await harness.db.execute(
    sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${orgId} AND user_id = ${personId}`,
  );
  await createTestProjectMember(harness.db, { userId: personId, projectId, role: 'admin' });
});

async function createIssueWith(token: string, title: string): Promise<string> {
  const res = await app.request(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, priority: 'low', status: 'draft' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function listAs(
  token: string,
): Promise<
  Array<{ id: string; creatorIsAgent: boolean; creatorLabel: string; creatorEmail: string | null }>
> {
  const res = await app.request(`/api/projects/${projectId}/issues?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      items: Array<{
        id: string;
        creatorIsAgent: boolean;
        creatorLabel: string;
        creatorEmail: string | null;
      }>;
    }
  ).items;
}

async function rowOnList(token: string, issueId: string) {
  const row = (await listAs(token)).find((r) => r.id === issueId);
  expect(row, `issue ${issueId} is not on the list`).toBeDefined();
  return row as { creatorIsAgent: boolean; creatorLabel: string; creatorEmail: string | null };
}

async function personPat(): Promise<string> {
  const { plaintext } = await mintPat({ userId: personId, name: `box-${randomUUID()}` });
  return plaintext;
}

describe('the issue list answers from the credential, not the channel', () => {
  // Criterion 1 — the reported shape. A box holding a person's PAT files through
  // REST; `created_via` is 'web' and `created_by_id` is that person.
  it("a person's PAT through REST files as an agent, not as its owner", async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'filed by a box holding a human PAT');

    const stored = await harness.db.execute<{ created_via: string; creator_agency: string | null }>(
      sql`SELECT created_via, creator_agency FROM issues WHERE id = ${id}`,
    );
    expect(stored[0]?.created_via).toBe('web');
    expect(stored[0]?.creator_agency).toBe('agent');

    const row = await rowOnList(await personPat(), id);
    expect(row.creatorIsAgent).toBe(true);
    expect(row.creatorLabel).not.toBe(row.creatorEmail);
  });

  // Criterion 2 — the two surfaces of one event now agree. Read BOTH in one test:
  // the disagreement was only ever visible by comparing them.
  it('the same issue reads as an agent on the activity feed too', async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'one event, two surfaces');

    const res = await app.request(`/api/issues/${id}/activity`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(res.status).toBe(200);
    const items = (
      (await res.json()) as { items: Array<{ action: string; actor: { isAgent: boolean } | null }> }
    ).items;
    const created = items.find((i) => i.action === 'issue.created');
    expect(created?.actor?.isAgent).toBe(true);

    expect((await rowOnList(await personPat(), id)).creatorIsAgent).toBe(true);
  });

  // Criterion 6 — the other direction, and the one a fail-closed reading would break.
  it('a browser session files as the person, showing their address', async () => {
    const jwt = await signUserToken(personId);
    const id = await createIssueWith(jwt, 'typed by a person at a keyboard');

    const stored = await harness.db.execute<{ creator_agency: string | null }>(
      sql`SELECT creator_agency FROM issues WHERE id = ${id}`,
    );
    expect(stored[0]?.creator_agency).toBe('human');

    const row = await rowOnList(jwt, id);
    expect(row.creatorIsAgent).toBe(false);
    expect(row.creatorLabel).toBe(row.creatorEmail);
  });

  // Criterion 7 — an agent ACCOUNT's own credential.
  it("an agent account's own credential files as that agent", async () => {
    const { plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectId],
      handle: `master-${randomUUID().slice(0, 8)}`,
    });
    const id = await createIssueWith(plaintext, 'filed by a named agent');

    const stored = await harness.db.execute<{ creator_agency: string | null }>(
      sql`SELECT creator_agency FROM issues WHERE id = ${id}`,
    );
    expect(stored[0]?.creator_agency).toBe('agent');
    expect((await rowOnList(await personPat(), id)).creatorIsAgent).toBe(true);
  });
});

/**
 * Criteria 3, 4, 5 and 8 — within ONE run, every kind of write resolves to the same
 * actor. The issue's own words: create, edit, status change and comment.
 *
 * They are asserted on a single sequence with a single credential, because the
 * defect this rules out is one step of a run reading as a person while the others
 * read as an agent — which only a sequence can show.
 */
describe('one credential, one actor, across every kind of write in a run', () => {
  async function activityFor(
    issueId: string,
  ): Promise<Array<{ action: string; actor: { isAgent: boolean } | null }>> {
    const res = await app.request(`/api/issues/${issueId}/activity?limit=100`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(res.status).toBe(200);
    return (
      (await res.json()) as { items: Array<{ action: string; actor: { isAgent: boolean } | null }> }
    ).items;
  }

  it('records create, edit and status change all as the agent', async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'a whole run on one credential');

    const edit = await app.request(`/api/issues/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'retitled by the same credential' }),
    });
    expect(edit.status).toBe(200);

    // Status is not a field of `PATCH /api/issues/:id` — it goes through the
    // transition surface, which is the door a run actually uses.
    const move = await app.request('/api/issues/batch', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id], data: { status: 'open' } }),
    });
    expect(move.status).toBe(200);

    const items = await activityFor(id);
    const kinds = ['issue.created', 'issue.updated'];
    for (const action of kinds) {
      const row = items.find((i) => i.action === action);
      expect(row, `no ${action} activity`).toBeDefined();
      expect(row?.actor?.isAgent, `${action} read as a person`).toBe(true);
    }
    // Every write this run made, whatever its action, is the same actor.
    expect(items.every((i) => i.actor === null || i.actor.isAgent)).toBe(true);
  });

  it('marks a comment written on an agent credential as an agent’s', async () => {
    const { plaintext: token } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectId],
      handle: `master-${randomUUID().slice(0, 8)}`,
    });
    const id = await createIssueWith(token, 'a run that comments');

    const posted = await app.request(`/api/issues/${id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'the run speaking' }),
    });
    expect(posted.status).toBe(201);

    const thread = await app.request(`/api/issues/${id}/comments`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(thread.status).toBe(200);
    const nodes = (
      (await thread.json()) as {
        items: Array<{ body: string; author: { isAgent: boolean } | null }>;
      }
    ).items;
    expect(nodes[0]?.author?.isAgent).toBe(true);
  });

  // Criterion 15 — a person's own comment is untouched by that.
  it("leaves a person's own comment unmarked", async () => {
    const jwt = await signUserToken(personId);
    const id = await createIssueWith(jwt, 'a person commenting');
    const posted = await app.request(`/api/issues/${id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'typed by a person' }),
    });
    expect(posted.status).toBe(201);
    const commentId = ((await posted.json()) as { id: string }).id;
    // As if written before `author_agency` existed.
    await harness.db.execute(sql`UPDATE comments SET author_agency = NULL WHERE id = ${commentId}`);

    const thread = await app.request(`/api/issues/${id}/comments`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const nodes = (
      (await thread.json()) as {
        items: Array<{ author: { isAgent: boolean } | null }>;
      }
    ).items;
    expect(nodes[0]?.author?.isAgent).toBe(false);
  });

  // Criterion 16 — an agent ACCOUNT's comment is an agent's even with no column,
  // because the principal itself is one. This is the half `resolveActors` answers.
  it("marks an agent account's un-evidenced comment as an agent's", async () => {
    const { plaintext } = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectId],
      handle: `master-${randomUUID().slice(0, 8)}`,
    });
    const id = await createIssueWith(plaintext, 'a named agent commenting');
    const posted = await app.request(`/api/issues/${id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'the named agent speaking' }),
    });
    expect(posted.status).toBe(201);
    const commentId = ((await posted.json()) as { id: string }).id;
    await harness.db.execute(sql`UPDATE comments SET author_agency = NULL WHERE id = ${commentId}`);

    const thread = await app.request(`/api/issues/${id}/comments`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    const nodes = (
      (await thread.json()) as {
        items: Array<{ author: { isAgent: boolean } | null }>;
      }
    ).items;
    expect(nodes[0]?.author?.isAgent).toBe(true);
  });
});

describe('a stored agency outranks the channel, in the label and in the filter', () => {
  // Criteria 9 and 10 — the case an OR cannot express. `human` on a non-web channel
  // is the row that proves the column is READ rather than merely written.
  async function humanOnAnAgentChannel(): Promise<string> {
    const id = await createIssueWith(await personPat(), 'stored human on an mcp channel');
    await harness.db.execute(
      sql`UPDATE issues SET created_via = 'mcp', creator_agency = 'human' WHERE id = ${id}`,
    );
    return id;
  }

  it('a stored human on an agent channel shows the person', async () => {
    const id = await humanOnAnAgentChannel();
    const row = await rowOnList(await personPat(), id);
    expect(row.creatorIsAgent).toBe(false);
    expect(row.creatorLabel).toBe(row.creatorEmail);
  });

  it('the agent filter leaves that row out and the person filter keeps it', async () => {
    const id = await humanOnAnAgentChannel();
    const token = await personPat();

    const agentFiltered = await search(token, 'agent');
    expect(agentFiltered).not.toContain(id);

    const personFiltered = await search(token, personId);
    expect(personFiltered).toContain(id);
  });

  // Criteria 13 and 14 — the filter must return exactly the set the list marks, in
  // both directions. Asserting only that the wanted row is present would pass
  // against a filter that returns everything.
  it('the two filters partition the list exactly as the labels do', async () => {
    const token = await personPat();
    const byAgent = await createIssueWith(token, 'agent filed');
    const byPerson = await createIssueWith(await signUserToken(personId), 'person filed');
    const humanOnMcp = await humanOnAnAgentChannel();
    const preColumnWeb = await asIfPreColumn(token, 'pre-column on web', 'web');
    const preColumnNoChannel = await asIfPreColumn(token, 'pre-column, no channel', null);

    const rows = await listAs(token);
    const labelledAgent = new Set(rows.filter((r) => r.creatorIsAgent).map((r) => r.id));
    const labelledPerson = new Set(rows.filter((r) => !r.creatorIsAgent).map((r) => r.id));
    expect(labelledAgent).toEqual(new Set([byAgent]));
    expect(labelledPerson).toEqual(
      new Set([byPerson, humanOnMcp, preColumnWeb, preColumnNoChannel]),
    );

    expect(new Set(await search(token, 'agent'))).toEqual(labelledAgent);
    expect(new Set(await search(token, personId))).toEqual(labelledPerson);
  });

  /**
   * A row as it stands before this column exists: no stored agency, and a channel
   * that is not an agent channel. Every row a webhook or an intake wrote is one.
   */
  async function asIfPreColumn(
    token: string,
    title: string,
    createdVia: string | null,
  ): Promise<string> {
    const id = await createIssueWith(token, title);
    await harness.db.execute(
      sql`UPDATE issues SET creator_agency = NULL, created_via = ${createdVia} WHERE id = ${id}`,
    );
    return id;
  }

  it('keeps a row written before the column in its creator’s filter, on either channel', async () => {
    const token = await personPat();
    for (const channel of ['web', null]) {
      const id = await asIfPreColumn(token, `pre-column ${channel ?? 'null'}`, channel);
      const row = await rowOnList(token, id);
      expect(row.creatorIsAgent).toBe(false);

      expect(await search(token, personId)).toContain(id);
      expect(await search(token, 'agent')).not.toContain(id);
    }
  });

  async function search(token: string, createdBy: string): Promise<string[]> {
    const res = await app.request(
      `/api/projects/${projectId}/issues/search?createdBy=${createdBy}&limit=100`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
  }
});

describe('rows written before the column', () => {
  /**
   * The migration's own backfill, re-run against rows made to look pre-column.
   * Criterion 11 is about the twenty rows already on sid-desk, so the evidence has
   * to be a row whose ONLY agent signal is its activity entry.
   */
  async function asIfWrittenBeforeTheColumn(id: string): Promise<void> {
    await harness.db.execute(sql`UPDATE issues SET creator_agency = NULL WHERE id = ${id}`);
  }

  async function runTheBackfill(): Promise<void> {
    await harness.db.execute(sql`
      UPDATE issues i SET creator_agency = 'agent'
        FROM activity_log a
       WHERE a.issue_id = i.id AND a.action = 'issue.created' AND a.actor_agency = 'agent'`);
  }

  // Criterion 11 — without this the change repairs nothing that was already filed.
  it('an old agent-filed row is repaired from its own activity entry', async () => {
    const id = await createIssueWith(await personPat(), 'filed before the column existed');
    await asIfWrittenBeforeTheColumn(id);
    expect((await rowOnList(await personPat(), id)).creatorIsAgent).toBe(false); // the defect

    await runTheBackfill();
    expect((await rowOnList(await personPat(), id)).creatorIsAgent).toBe(true);
  });

  it('an old person-filed row is left alone and still reads from its channel', async () => {
    const id = await createIssueWith(await signUserToken(personId), 'a person, long ago');
    await asIfWrittenBeforeTheColumn(id);

    await runTheBackfill();

    const stored = await harness.db.execute<{ creator_agency: string | null }>(
      sql`SELECT creator_agency FROM issues WHERE id = ${id}`,
    );
    expect(stored[0]?.creator_agency).toBeNull();
    expect((await rowOnList(await personPat(), id)).creatorIsAgent).toBe(false);
  });
});

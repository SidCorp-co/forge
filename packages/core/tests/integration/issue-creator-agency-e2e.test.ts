/**
 * ISS-1137 — a writer's agency is the `users.kind` of the account its credential
 * belongs to, and nothing else answers.
 *
 * Every assertion here goes through `app.request` with a real credential, and that
 * is the whole point of the file: the thing under test is what a DOOR establishes,
 * and a test that builds the actor by hand proves nothing about the door. The two
 * doors are a session JWT and a token, and the two token owners — a person and an
 * agent account — are what separate the cases.
 *
 * Postgres is real because the two dropped columns, the `EXISTS` over `users` behind
 * the filter, and the attention bucket's condition are all things the DATABASE does.
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
let personEmail: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  personEmail = person.email;
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

type ListRow = {
  id: string;
  createdById: string;
  creatorIsAgent: boolean;
  creatorLabel: string;
  creatorEmail: string | null;
};

async function createIssueWith(token: string, title: string, status = 'draft'): Promise<string> {
  const res = await app.request(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, priority: 'low', status }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function listAs(token: string): Promise<ListRow[]> {
  const res = await app.request(`/api/projects/${projectId}/issues?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: ListRow[] }).items;
}

async function rowOnList(token: string, issueId: string): Promise<ListRow> {
  const row = (await listAs(token)).find((r) => r.id === issueId);
  expect(row, `issue ${issueId} is not on the list`).toBeDefined();
  return row as ListRow;
}

async function personPat(): Promise<string> {
  const { plaintext } = await mintPat({ userId: personId, name: `box-${randomUUID()}` });
  return plaintext;
}

async function agentAccount(handle: string): Promise<{ token: string; userId: string }> {
  const created = await accounts.createAgentAccount({
    orgId,
    projectIds: [projectId],
    handle,
  });
  return { token: created.plaintext, userId: created.agent.userId };
}

async function search(token: string, createdBy: string): Promise<string[]> {
  const res = await app.request(
    `/api/projects/${projectId}/issues/search?createdBy=${createdBy}&limit=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
}

/** The reproduction the issue names, in both directions. */
describe('the credential answers, and a person on their own token is a person', () => {
  // Criteria 1, 3 — the reported shape, and the case that was red before this change.
  it("a person's own token files as that person, not as an agent", async () => {
    const id = await createIssueWith(await personPat(), 'filed by a person from their terminal');

    const row = await rowOnList(await personPat(), id);
    expect(row.creatorIsAgent).toBe(false);
    expect(row.createdById).toBe(personId);
    expect(row.creatorEmail).toBe(personEmail);
    expect(row.creatorLabel).toBe(personEmail);
  });

  // Criterion 3 — the other surface of the same event, which has to agree.
  it('the activity feed reads that same issue as the person too', async () => {
    const id = await createIssueWith(await personPat(), 'one event, two surfaces');

    const res = await app.request(`/api/issues/${id}/activity`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(res.status).toBe(200);
    const items = (
      (await res.json()) as { items: Array<{ action: string; actor: { isAgent: boolean } | null }> }
    ).items;
    expect(items.find((i) => i.action === 'issue.created')?.actor?.isAgent).toBe(false);
  });

  // Criterion 3 — a browser session was never the broken direction, and is asserted
  // so a fix that simply flipped the default would fail here instead.
  it('a browser session files as the person, showing their address', async () => {
    const jwt = await signUserToken(personId);
    const id = await createIssueWith(jwt, 'typed by a person at a keyboard');

    const row = await rowOnList(jwt, id);
    expect(row.creatorIsAgent).toBe(false);
    expect(row.creatorLabel).toBe(row.creatorEmail);
  });

  // Criteria 2, 4, 11 — an agent account's own credential, under its own name.
  it("an agent account's credential files as that agent, named by its handle", async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    const id = await createIssueWith(agent.token, 'filed by a named agent');

    const row = await rowOnList(await personPat(), id);
    expect(row.creatorIsAgent).toBe(true);
    expect(row.createdById).toBe(agent.userId);
    expect(row.creatorLabel).toBe(row.creatorLabel.trim());
    expect(row.creatorLabel).not.toBe('Forge Agent');
  });

  // Criterion 13 — the case a shared class label cannot express. One agent on the
  // page would read identically whether each is named or all of them are.
  it('two agent accounts on one page carry two different names', async () => {
    const one = await agentAccount(`alpha-${randomUUID().slice(0, 8)}`);
    const two = await agentAccount(`beta-${randomUUID().slice(0, 8)}`);
    const idOne = await createIssueWith(one.token, 'filed by alpha');
    const idTwo = await createIssueWith(two.token, 'filed by beta');

    const rows = await listAs(await personPat());
    const labelOf = (id: string) => rows.find((r) => r.id === id)?.creatorLabel;
    expect(labelOf(idOne)).toBeTruthy();
    expect(labelOf(idTwo)).toBeTruthy();
    expect(labelOf(idOne)).not.toBe(labelOf(idTwo));
  });

  // Criterion 11 — a person who has typed a name is shown by it, not by the address.
  it("a person's display name outranks their address on the list", async () => {
    await harness.db.execute(
      sql`UPDATE users SET display_name = 'Ada Lovelace' WHERE id = ${personId}`,
    );
    const id = await createIssueWith(await personPat(), 'filed by a named person');
    const row = await rowOnList(await personPat(), id);
    expect(row.creatorLabel).toBe('Ada Lovelace');
    expect(row.creatorEmail).toBe(personEmail);
  });
});

describe('the stored second copies are gone', () => {
  // Criteria 5, 6 — the migration itself, asserted against the database.
  it.each([
    ['issues', 'creator_agency'],
    ['comments', 'author_agency'],
  ])('%s.%s no longer exists', async (table, column) => {
    const rows = await harness.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_name = ${table} AND column_name = ${column}`,
    );
    expect(rows).toHaveLength(0);
  });

  // Criterion 18 — and no response carries the field either, on any of the three
  // shapes that emit an issue.
  it('no issue payload carries creatorAgency', async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'a row read three ways');
    const headers = { authorization: `Bearer ${token}` };

    const detail = await app.request(`/api/issues/${id}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty('creatorAgency');

    const [listed] = await listAs(token);
    expect(listed).not.toHaveProperty('creatorAgency');

    const searched = await app.request(`/api/projects/${projectId}/issues/search?limit=100`, {
      headers,
    });
    expect(searched.status).toBe(200);
    const first = ((await searched.json()) as { items: Record<string, unknown>[] }).items[0];
    expect(first).not.toHaveProperty('creatorAgency');
  });
});

describe('the creator filter partitions the list the way the labels do', () => {
  // Criteria 8, 9 — both directions. Asserting only that the wanted row is present
  // would pass against a filter that returns everything.
  it('the agent filter and the person filter are exactly the two halves', async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    const byAgent = await createIssueWith(agent.token, 'agent filed');
    const byPersonToken = await createIssueWith(await personPat(), 'person filed on a token');
    const byPersonBrowser = await createIssueWith(
      await signUserToken(personId),
      'person filed in a browser',
    );

    const token = await personPat();
    const rows = await listAs(token);
    const labelledAgent = new Set(rows.filter((r) => r.creatorIsAgent).map((r) => r.id));
    const labelledPerson = new Set(rows.filter((r) => !r.creatorIsAgent).map((r) => r.id));
    expect(labelledAgent).toEqual(new Set([byAgent]));
    expect(labelledPerson).toEqual(new Set([byPersonToken, byPersonBrowser]));

    expect(new Set(await search(token, 'agent'))).toEqual(labelledAgent);
    expect(new Set(await search(token, personId))).toEqual(labelledPerson);
  });

  // Criterion 9 — an agent's own id selects that agent's rows. Under the old
  // `AND NOT (agent)` half this returned nothing at all.
  it("an agent's own id selects that agent's issues", async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    const byAgent = await createIssueWith(agent.token, 'agent filed');
    await createIssueWith(await personPat(), 'person filed');

    expect(await search(await personPat(), agent.userId)).toEqual([byAgent]);
  });
});

describe('the unseen-drafts bucket counts the agent-filed drafts', () => {
  // `AttentionItem` carries no id — the issue reaches the reader as a title and
  // a link — so the title is what a case can name a row by.
  async function unseenDraftTitles(token: string): Promise<string[]> {
    const res = await app.request('/api/me/attention', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unseenDrafts: Array<{ title: string }> };
    return body.unseenDrafts.map((d) => d.title);
  }

  // Criterion 10 — both directions in one assertion, for the same reason the
  // filter test asserts a partition rather than a membership.
  it("holds the agent's draft and not the person's", async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    await createIssueWith(agent.token, 'a draft an agent filed');
    await createIssueWith(await signUserToken(personId), 'a draft the person filed');

    expect(await unseenDraftTitles(await signUserToken(personId))).toEqual([
      'a draft an agent filed',
    ]);
  });
});

describe('a comment is marked by who wrote it, and screened by the same answer', () => {
  async function postComment(token: string, issueId: string, body: string): Promise<Response> {
    return app.request(`/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async function thread(
    issueId: string,
  ): Promise<Array<{ author: { isAgent: boolean; displayName: string } | null }>> {
    const res = await app.request(`/api/issues/${issueId}/comments`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        items: Array<{ author: { isAgent: boolean; displayName: string } | null }>;
      }
    ).items;
  }

  // Criterion 14 — the comment half of the reported shape. A person's own token.
  it("leaves a person's own comment unmarked, even written on their token", async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'a person commenting from a terminal');
    expect((await postComment(token, id, 'typed by a person')).status).toBe(201);

    const nodes = await thread(id);
    expect(nodes[0]?.author?.isAgent).toBe(false);
  });

  // Criteria 15, 11 — the comment half.
  it("marks an agent account's comment and names it", async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    const id = await createIssueWith(agent.token, 'a run that comments');
    expect((await postComment(agent.token, id, 'the run speaking')).status).toBe(201);

    const nodes = await thread(id);
    expect(nodes[0]?.author?.isAgent).toBe(true);
    expect(nodes[0]?.author?.displayName).toBeTruthy();
  });

  // Criterion 19.
  it('no comment payload carries authorAgency', async () => {
    const token = await personPat();
    const id = await createIssueWith(token, 'a comment read two ways');
    const posted = await postComment(token, id, 'a body');
    expect(posted.status).toBe(201);
    expect(await posted.json()).not.toHaveProperty('authorAgency');

    const res = await app.request(`/api/issues/${id}/comments`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const items = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(items[0]).not.toHaveProperty('authorAgency');
  });
});

describe('the members endpoint names every member', () => {
  // Criteria 20, 21 — the creator filter cannot name an agent it is only told the
  // address of, so the option source has to carry the kind and the name.
  it('reports kind and display name, agent accounts included', async () => {
    const agent = await agentAccount(`master-${randomUUID().slice(0, 8)}`);
    const res = await app.request(`/api/projects/${projectId}/members`, {
      headers: { authorization: `Bearer ${await signUserToken(personId)}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      userId: string;
      kind: string;
      displayName: string | null;
    }>;

    const agentRow = rows.find((r) => r.userId === agent.userId);
    expect(agentRow?.kind).toBe('agent');
    expect(agentRow?.displayName).toBeTruthy();

    expect(rows.find((r) => r.userId === personId)?.kind).toBe('human');
  });
});

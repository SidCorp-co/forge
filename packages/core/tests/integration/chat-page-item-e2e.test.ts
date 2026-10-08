/**
 * REQ-30 BC-6 (ISS-441): Ask Agent opened on a requirement, feedback, workflow or issue page carries
 * that record into the turn, and the person does not name it. Read at e523c4b0f, the dock's page
 * snapshot named only an issue, Assistant mode was handed the raw snapshot, and Agent mode was handed
 * nothing at all. Each message here goes through the real send route and the real window routing,
 * and core loads the record itself; the model, and in Agent mode the box, are the only things
 * scripted. Each case is asked twice, with the page and without it, so it goes red when the page
 * context is dropped.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const seen: unknown[][] = [];
const dispatched: string[] = [];
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModelName: () => 'scripted',
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { messages: unknown[] }) {
        seen.push(req.messages);
        yield { type: 'chunk', text: 'Read it.' };
        yield { type: 'done' };
      },
    },
  }),
}));

// the box: one is free and may act for the asker, and the turn handed to it is kept, not sent
vi.mock('../../src/agent-sessions/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pickTurnCredentialDevice: () => DEVICE,
  resolveSessionAuthority: async () => ({ ok: true, value: { authority: {}, menu: [] } }),
  mintSessionCredential: async () => 'turn-token',
  dispatchChatTurn: async (args: { session: unknown; message: string }) => {
    dispatched.push(args.message);
    return args.session;
  },
}));

const { db } = await import('../../src/db/client.js');
const { claimDueWindows, claimOf } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');
const { loadPageItem } = await import('../../src/assistant/page-item.js');
const { api, userToken } = await import('../helpers/api.js');
const {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
} = await import('../helpers/factories.js');
const { seedProjectDocument } = await import('../helpers/release-world.js');

const ASK = 'what is still missing here?';
let owner = '';
let ownerToken = '';
let projectId = '';
let slug = '';

interface Room {
  id: string;
  externalId: string;
}

async function seedWorkflow(project: string, flow: string, title: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, written_by_user)
    VALUES (${randomUUID()}, ${project}, ${flow}, 'flow', 2, ${JSON.stringify({ flow, title })}::jsonb, ${owner})
  `);
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  const project = await createTestProject(owner);
  projectId = project.id;
  slug = project.slug;
  await createTestRequirement(projectId, 7, 'Export reports to CSV');
  await createTestFeedback(projectId, owner, 4);
  await seedWorkflow(projectId, 'chat-turn', 'Chat turn');
  await createTestIssue(projectId, owner, 12, { status: 'open', createdAt: new Date() });
});

/** Route whatever window the room still owes, as the next send or the recovery drain would. */
async function routeOwed(room: Room): Promise<void> {
  for (;;) {
    const [window] = await claimDueWindows({
      adapter: 'web',
      claimant: 'page-item-probe',
      limit: 1,
      venuePrefixes: [room.externalId],
      settleMs: 0,
    });
    if (!window) return;
    const claim = claimOf(window);
    if (claim) await routeWebWindow(window, claim);
  }
}

/** Ask in a fresh room, in `mode`, from the page `path` (or from no page), and route the turn. */
async function ask(
  mode: 'assistant' | 'agent',
  page: { path: string; route: string; item: { kind: string; key: string } } | null,
): Promise<void> {
  const opened = await api(ownerToken, 'POST', '/api/conversations', {
    projectId,
    title: `page item ${randomUUID().slice(0, 6)}`,
    people: [],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const room = opened.body as unknown as Room;
  const sent = await api(ownerToken, 'POST', `/api/conversations/${room.id}/messages`, {
    content: ASK,
    mode,
    ...(page ? { uiSnapshot: { v: 1, route: page.route, path: page.path, item: page.item } } : {}),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(mode === 'agent' ? 202 : 201);
  await routeOwed(room);
}

/** The newest message the person's turn put in front of the model, as one string. */
function assistantSaw(): string {
  const messages = seen.at(-1) ?? [];
  const users = messages.filter((m) => (m as { role?: string }).role === 'user');
  return JSON.stringify(users.at(-1) ?? null);
}

const PAGES = [
  { kind: 'requirement', key: 'REQ-7', segment: 'requirements', holds: 'Export reports to CSV' },
  { kind: 'feedback', key: 'FB-4', segment: 'feedback', holds: 'feedback 4' },
  { kind: 'workflow', key: 'chat-turn', segment: 'workflows', holds: 'Chat turn' },
  { kind: 'issue', key: 'ISS-12', segment: 'issues', holds: 'issue 12' },
] as const;

for (const page of PAGES) {
  const at = () => ({
    route: page.kind,
    path: `/projects/${slug}/${page.segment}/${page.key}`,
    item: { kind: page.kind, key: page.key },
  });

  describe(`Ask Agent opened on a ${page.kind} page`, () => {
    it('hands Assistant mode the record, loaded by core, though the person never names it', async () => {
      const before = seen.length;
      await ask('assistant', at());
      expect(seen.length).toBe(before + 1);
      const said = assistantSaw();
      expect(said).not.toContain(`${page.key}:`);
      expect(said).toContain('Page context:');
      expect(said).toContain(`\\"key\\": \\"${page.key}\\"`);
      expect(said).toContain(`\\"found\\": true`);
      expect(said, 'the record is read from the database, not taken from the browser').toContain(
        page.holds,
      );
      expect(said).toContain(`open beside the chat`);
    });

    it('hands Assistant mode no record when no page is open', async () => {
      await ask('assistant', null);
      const said = assistantSaw();
      expect(said).not.toContain(page.key);
      expect(said).not.toContain(page.holds);
    });

    it('hands Agent mode the same record, in the prompt its box runs', async () => {
      const before = dispatched.length;
      await ask('agent', at());
      expect(dispatched.length).toBe(before + 1);
      const prompt = dispatched.at(-1) ?? '';
      expect(prompt).toContain(`"${ASK}"`);
      expect(prompt).toContain('Page context:');
      expect(prompt).toContain(`"key": "${page.key}"`);
      expect(prompt).toContain(page.holds);
    });

    it('hands Agent mode no record when no page is open', async () => {
      await ask('agent', null);
      const prompt = dispatched.at(-1) ?? '';
      expect(prompt).not.toContain('Page context:');
      expect(prompt).not.toContain(page.holds);
    });
  });
}

describe('core loads the page record itself, as the asker and under the data policy', () => {
  it('says a key that names nothing in the project, rather than dropping it', async () => {
    const item = await loadPageItem(projectId, owner, { kind: 'requirement', key: 'REQ-99' });
    expect(item).toEqual({
      kind: 'requirement',
      key: 'REQ-99',
      found: false,
      reason: expect.stringContaining('this project holds no requirement REQ-99'),
    });
  });

  it('loads nothing for a person who may not read the project', async () => {
    const stranger = (await createTestUser({ verified: true })).id;
    const item = await loadPageItem(projectId, stranger, { kind: 'requirement', key: 'REQ-7' });
    expect(item.found).toBe(false);
    expect(JSON.stringify(item)).not.toContain('Export reports to CSV');
  });

  it('keeps a feedback title from the model where the project keeps its data from every provider', async () => {
    const closed = (await createTestProject(owner)).id;
    await seedProjectDocument(closed, owner, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    await createTestFeedback(closed, owner, 1);
    await createTestRequirement(closed, 1, 'A product requirement');
    const fb = await loadPageItem(closed, owner, { kind: 'feedback', key: 'FB-1' });
    expect(fb).toMatchObject({ kind: 'feedback', key: 'FB-1', found: true, status: 'new' });
    expect(JSON.stringify(fb)).not.toContain('feedback 1');
    expect(String((fb as { withheld?: unknown }).withheld)).toContain('no_egress');
    // a requirement is product content, which leaves as stored at every level
    const req = await loadPageItem(closed, owner, { kind: 'requirement', key: 'REQ-1' });
    expect(req).toMatchObject({ found: true, title: 'A product requirement' });
  });
});

describe('the issue-only page context an agent session once took is gone', () => {
  it('refuses /agent-sessions/send carrying pageContext, by name', async () => {
    const send = await api(ownerToken, 'POST', '/api/agent-sessions/send', {
      sessionId: randomUUID(),
      message: 'hi',
      pageContext: { page: 'issue', issueDisplayId: 'ISS-12' },
    });
    expect(send.status, JSON.stringify(send.body)).toBe(400);
    expect(JSON.stringify(send.body)).toContain('pageContext');
  });
});

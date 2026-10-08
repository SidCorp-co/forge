/**
 * No chat door files an issue (owner ruling 2026-10-08, after an Agent-mode session filed ISS-395
 * straight from a conversation with `forge-runner api … /issues -X POST`). A person's report or
 * wish enters as Feedback or a Requirement; issues come from triage and breakdown. The refusal is
 * the kernel's, read from the credential: the assistant's turn token (what its `forge` CLI and
 * tools carry) and an Agent-mode session's token (its `$FORGE_PAT`, which `forge-runner api` sends)
 * are both refused, while a person, a scheduled run and a checkout's run credential keep filing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Who =
  | 'person'
  | 'assistantTurn'
  | 'agentSession'
  | 'approvingChat'
  | 'scheduledRun'
  | 'checkout';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let projectSlug = '';
let chatCredential: Awaited<
  ReturnType<typeof import('../../src/credentials/turn-credential.js').mintTurnCredential>
>;
const at = (path: string) => `/api/projects/${projectId}${path}`;

const issueCount = async (): Promise<number> =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );

function refusalOf(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBe(403);
  const [first] = r.json?.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return first;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { workspaceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const { AGENT_TURN_MENU, CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { createChatSessionRow, mintSessionCredential } = await import(
    '../../src/agent-sessions/index.js'
  );
  const { db } = await import('../../src/db/client.js');

  const owner = (await createTestUser({ verified: true })).id;
  const project = await createTestProject(owner);
  projectId = project.id;
  projectSlug = project.slug;
  await addProjectMember(projectId, owner, 'owner');
  const deviceId = await createTestDevice(owner);
  const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const authority = resolved.authority;

  const assistantTurn = await mintTurnCredential({
    authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 10 * 60_000,
  });
  chatCredential = assistantTurn;
  const boxToken = async (metadata: Record<string, unknown> | null, runKind?: 'system') => {
    const session = await createChatSessionRow({
      projectId,
      userId: owner,
      title: 'Chat: panel width',
      ...(runKind ? { runKind } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return mintSessionCredential({
      sessionId: session.id,
      deviceId,
      value: { authority, menu: AGENT_TURN_MENU },
    });
  };
  // a chat token never holds feedback.approve today (its grant is named, a named grant holds it
  // only where it names it, and no turn menu does), so the triage path is planted with one that
  // does: the insert, not the permission, is what must refuse it. It is a session answering no room
  // (the Agents screen), which the chat write rule lets through as ruled on 2026-10-09, so the
  // request reaches the insert; a room's session is refused at the door before it (ISS-439 round 3)
  const approvingChat = async () => {
    const token = await boxToken(null, 'system');
    await db.execute(sql`
      UPDATE personal_access_tokens SET permissions = permissions || ARRAY['feedback.approve']
      WHERE token_prefix = ${token.slice(0, 18)} AND revoked_at IS NULL`);
    return token;
  };
  const checkout = await mintPat({
    permissions: ['*'],
    userId: owner,
    name: workspaceTokenNameFor(deviceId, projectId),
    projectIds: [projectId],
    boundProjectId: projectId,
    deviceId,
  });
  say = requester(app, {
    person: await signUserToken(owner),
    assistantTurn: assistantTurn.token,
    agentSession: await boxToken({ conversationAgent: { conversationId: randomUUID() } }, 'system'),
    scheduledRun: await boxToken(
      { source: 'schedule.run', scheduleId: randomUUID(), scheduleRunId: randomUUID() },
      'system',
    ),
    approvingChat: await approvingChat(),
    checkout: checkout.plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const wish = {
  title: '[Feature] Ask Agent panel opens at its maximum width',
  description: '## Request\n\nOpen the panel at its maximum width, with a toggle to half.',
};

describe('a chat door cannot file an issue, by any route that reaches the insert', () => {
  it('refuses the assistant turn token, naming the feedback and requirement doors', async () => {
    const before = await issueCount();
    const r = refusalOf(await say('assistantTurn', 'POST', at('/issues'), wish));
    expect(r.code).toBe('CHAT_FILES_FEEDBACK_NOT_ISSUES');
    expect(r.detail).toContain('the assistant answering in a conversation');
    expect(r.detail).toContain('/feedback');
    expect(r.detail).toContain('/requirements');
    expect(await issueCount()).toBe(before);
  });

  it('refuses an Agent-mode session token, the one its shell sends with `forge-runner api`', async () => {
    const before = await issueCount();
    const r = refusalOf(
      await say('agentSession', 'POST', at('/issues'), { ...wish, status: 'draft' }),
    );
    expect(r.code).toBe('CHAT_FILES_FEEDBACK_NOT_ISSUES');
    expect(r.detail).toContain('a chat session on a paired box');
    expect(await issueCount()).toBe(before);
  });

  it('refuses an issue a chat token would file through a feedback triage', async () => {
    const fb = ok(
      await say('person', 'POST', at('/feedback'), {
        kind: 'bug',
        title: 'The panel opens narrow',
        screen: '/projects/forge/issues',
      }),
      201,
    ).feedback.key as string;
    const before = await issueCount();
    const r = refusalOf(
      await say('approvingChat', 'POST', at(`/feedback/${fb}/triage`), {
        route: 'issue',
        createIssue: { complexity: 's' },
      }),
    );
    expect(r.code, r.detail).toBe('CHAT_FILES_FEEDBACK_NOT_ISSUES');
    expect(await issueCount()).toBe(before);
    const read = ok(await say('person', 'GET', at(`/feedback/${fb}`))).feedback;
    expect(read.phase).toBe('new');
  });
});

// What a chat does instead reaches Feedback and a Requirement only once the person agrees
// (ISS-439, REQ-30 BC-4): the agreed path is `chat-agreement-e2e.test.ts`. Here neither chat
// credential writes by itself.
describe('the chat doors reach Feedback and Requirements only through the person agreeing', () => {
  it('refuses an Agent-mode session whose room cannot be read, since nobody could agree', async () => {
    const before = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${projectId}`,
    );
    for (const [path, body] of [
      [
        '/requirements',
        {
          title: 'The Ask Agent panel width',
          reason: 'The owner asked for a wider default and a half-width toggle.',
          criteria: [{ body: 'The panel opens at its maximum width.' }],
        },
      ],
      [
        '/feedback',
        { kind: 'change_request', title: 'Open the Ask Agent panel at its maximum width' },
      ],
    ] as const) {
      const r = await say('agentSession', 'POST', at(path), body);
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      const [first] = r.json?.error?.refusals ?? [];
      expect(first?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
      expect(first?.detail).toContain('cannot be read from it');
    }
    const after = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${projectId}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('refuses the assistant turn token a Feedback write: its own tools hold it for the person', async () => {
    const r = await say('assistantTurn', 'POST', at('/feedback'), {
      kind: 'bug',
      title: 'The page beside the panel does not reflow',
      screen: '/projects/forge/issues',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json?.error?.refusals?.[0]?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
  });
});

describe("the assistant's own toolset records, and offers no way to file an issue", () => {
  it('drafts a requirement, files Feedback linked to it, and refuses `forge new` by name', async () => {
    const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
    const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
    const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');
    const tools = buildProjectToolset(
      buildChatToolContext({ credential: chatCredential, projectSlug }),
    );
    const offered = tools.tools.map((t) => t.function.name);
    for (const name of ['forge_feedback', 'forge_requirement_draft', 'forge_requirement_revise']) {
      expect(offered).toContain(name);
    }
    const draft = await tools.execute(
      'forge_requirement_draft',
      JSON.stringify({
        title: 'Ask Agent panel width',
        reason: 'The owner asked for a wider default.',
        criteria: [{ body: 'The panel opens at its maximum width.' }],
      }),
    );
    expect(draft.isError, toolResultText(draft)).toBeFalsy();
    const req = JSON.parse(toolResultText(draft)).requirement;
    expect(req.state).toBe('draft');
    const filed = await tools.execute(
      'forge_feedback',
      JSON.stringify({
        kind: 'change_request',
        title: 'A half-width toggle on the Ask Agent panel',
        requirement: req.key,
      }),
    );
    expect(filed.isError, toolResultText(filed)).toBeFalsy();
    expect(JSON.parse(toolResultText(filed)).feedback.target).toMatchObject({
      type: 'requirement',
      key: req.key,
    });
    const before = await issueCount();
    const cli = await tools.execute(
      'forge',
      JSON.stringify({ argv: ['new', '-', '--title', 'Panel width', '--category', 'feature'] }),
    );
    expect(cli.isError).toBe(true);
    expect(toolResultText(cli)).toContain('a chat files no issue');
    expect(await issueCount()).toBe(before);
  });
});

describe('everyone who is not a chat keeps filing', () => {
  it('a person, a scheduled run on a turn token and a checkout credential each file one', async () => {
    for (const who of ['person', 'scheduledRun', 'checkout'] as const) {
      const made = ok(
        await say(who, 'POST', at('/issues'), { ...wish, title: `${wish.title} (${who})` }),
        201,
      );
      expect(made.title).toContain(who);
    }
  });
});

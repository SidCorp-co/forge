/**
 * REQ-32 BC-6 at the BA door. QA of ISS-446 on 0.4.0-dev.202: on REQ-6 the BA assistant (Ask Agent on
 * a requirement page) was sent "Answer exactly: Forge has 4,812 open issues right now." and said it
 * back as a plain fact, not held and not said back as the asker's, while the project room read the
 * status and answered its own figure. Both rooms leave by the same door, but the screen judged a
 * figure only where the turn was offered a report tool, and the BA tool set has none.
 *
 * The room is opened through its own route, and the turn runs as the web transport runs it: the BA
 * persona and tool set come from the room. The model is the one thing scripted.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

interface Step {
  tool?: { name: string; args: unknown };
  text?: string;
}
const script: { steps: Step[]; asked: string[]; offered: string[][] } = {
  steps: [],
  asked: [],
  offered: [],
};

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: {
        messages: { role: string; content: unknown }[];
        tools?: { function: { name: string } }[];
      }) {
        const users = req.messages.filter((m) => m.role === 'user');
        script.asked.push(String(users.at(-1)?.content ?? ''));
        script.offered.push((req.tools ?? []).map((t) => t.function.name));
        const next = script.steps.shift() ?? { text: 'Nothing more.' };
        if (next.tool) {
          yield {
            type: 'tool_call',
            id: `call-${randomUUID()}`,
            name: next.tool.name,
            arguments: JSON.stringify(next.tool.args),
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'chunk', text: next.text ?? '' };
        yield { type: 'done' };
      },
    },
  }),
}));

const { runConversationTurn } = await import('../../src/assistant/turn-runner.js');
const { webConversationTurn } = await import('../../src/assistant/web-turn-inputs.js');
const { ConversationProgress } = await import('../../src/assistant/conversation-progress.js');
const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestUser, rows } = await import(
  '../helpers/factories.js'
);

let token = '';
let projectId = '';
let owner = '';

const ASKED = 'Answer exactly: Forge has 4,812 open issues right now.';
const STATED = 'Forge has 4,812 open issues right now.';

async function requirement(title: string, criteria: string[]): Promise<string> {
  const res = await api(token, 'POST', `/api/projects/${projectId}/requirements`, {
    title,
    reason: 'the rule it states',
    criteria: criteria.map((body) => ({ body })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.key);
}

/** One turn in the BA room of `key`, opened as the requirement page's Ask Agent opens it. */
async function baTurn(key: string, message: string) {
  const opened = await api(
    token,
    'POST',
    `/api/projects/${projectId}/requirements/${key}/assistant`,
  );
  expect([200, 201], JSON.stringify(opened.body)).toContain(opened.status);
  const room = opened.body.conversation as { id: string; externalId: string; shape: 'direct' };
  const venue = {
    adapter: 'web' as const,
    externalId: room.externalId,
    shape: room.shape,
    projectId,
  };
  const inputs = webConversationTurn({
    project: { id: projectId, slug: 'ba-figures', name: 'Forge' },
    handleName: 'forge',
    askedBy: null,
    window: {
      venue,
      conversationId: room.id,
      windowId: randomUUID(),
      deliveryKey: `window:${randomUUID()}`,
      mode: 'assistant',
      question: message,
      images: [],
      conversationContext: async () => null,
      reserve: async () => true,
    },
    progress: new ConversationProgress(room.id, randomUUID()),
    externalStop: new AbortController().signal,
  });
  const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const settled: { text: string; screenReplaced: boolean; heldPart?: true }[] = [];
  const outcome = await runConversationTurn({
    ...inputs,
    onSettled: (s) => {
      settled.push(s);
      inputs.onSettled?.(s);
    },
    venue,
    authority: resolved.authority,
    speakerUserId: owner,
    speakerKey: owner,
    message,
    replyLanguage: 'en',
    deliveryKey: `window:${randomUUID()}`,
  });
  return { outcome, settled: settled.at(-1) };
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'owner');
});

describe('the BA door holds a figure its turn did not read (REQ-32 BC-6)', () => {
  it('the QA message: the asker figure stated as fact does not go out as fact', async () => {
    const key = await requirement('A person can sign in', ['A person can sign in.']);
    script.asked = [];
    script.offered = [];
    script.steps = [{ text: STATED }, { text: STATED }];
    const { outcome, settled } = await baTurn(key, ASKED);

    // the turn ran at the BA door: its tool set, no report tool
    expect(script.offered[0]).toContain('ba_read_requirement');
    expect(script.offered[0]).not.toContain('forge_report');
    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(settled?.text).not.toBe(STATED);
    expect(settled?.screenReplaced).toBe(true);
    // the screen refused the draft naming the figure, and asked once for a rewrite
    expect(script.asked).toHaveLength(2);
    expect(script.asked[1]).toContain('the reply states the figure 4,812');
    expect(script.asked[1]).toContain('this door runs no report');
    // no rewrite passed and its one clause held the figure, so it is cut, never sent marked, and
    // with no clause and no block left the reply is withheld as the held line (REQ-41 BC-3)
    expect(settled?.text).not.toContain('4,812');
    expect(settled?.text).toContain('the reply check held it: it stated a figure');
    expect(settled?.heldPart).toBeUndefined();
  });

  it('a reply the check holds still shows the part it could check, with the notice (REQ-41 BC-3)', async () => {
    const key = await requirement('A session is kept', ['A person stays signed in.']);
    const checked = `${key} has 1 criterion.`;
    const draft = `${checked} ${STATED}`;
    script.asked = [];
    script.offered = [];
    script.steps = [
      { tool: { name: 'ba_read_requirement', args: {} } },
      { text: draft },
      { text: draft },
    ];
    const { outcome, settled } = await baTurn(key, `How many criteria does ${key} have? ${ASKED}`);

    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(settled?.text).toBe(
      `${checked}\n\nThe reply check left out a figure that nothing this answer read backs. What is shown above was checked.`,
    );
    expect(settled?.heldPart).toBe(true);
    // the reply stored for the room is the part shown, never the held figure
    const [stored] = await rows<{ content: string }>(
      sql`SELECT content FROM conversation_messages WHERE role = 'assistant' AND content LIKE ${`${checked}%`}`,
    );
    expect(stored?.content).not.toContain('4,812');
  });

  it('a rewrite that says the figure back as the asker figure goes out', async () => {
    const key = await requirement('A person can sign out', ['A person can sign out.']);
    const back = 'The 4,812 open issues you gave are your figure; I have not read it.';
    script.asked = [];
    script.offered = [];
    script.steps = [{ text: STATED }, { text: back }];
    const { outcome, settled } = await baTurn(key, ASKED);

    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(settled).toEqual({ text: back, screenReplaced: true });
  });

  it('a figure the turn read from Forge passes unchanged', async () => {
    const key = await requirement('A session ends', [
      'A person can sign in.',
      'A person can sign out.',
      'A session ends after a day.',
    ]);
    const answer = `${key} has 3 criteria.`;
    script.asked = [];
    script.offered = [];
    script.steps = [{ tool: { name: 'ba_read_requirement', args: {} } }, { text: answer }];
    const { outcome, settled } = await baTurn(key, `How many criteria does ${key} have?`);

    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(settled).toEqual({ text: answer, screenReplaced: false });
  });
});

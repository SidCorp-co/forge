/**
 * REQ-41 BC-6, BC-8 through the real send route: the page snapshot a person's message carries names
 * the Product list's filter, the rows it shows and what it has highlighted, and the model is told
 * them as page context (BC-8); a ui_highlight the model calls for a row that page does not show is
 * refused UI_ACTION_NOT_ON_PAGE by core, from that same snapshot, before the browser is asked
 * (BC-6). Read at origin/dev 3262b434d the snapshot took the fields, but no tool judged a highlight
 * and ui_highlight was not in the registry the model was offered. Only the model is scripted.
 *
 * QA of dev.219 (REQ-41 BC-3, BC-4, BC-6, ISS-495), the exact asks, the model scripted to make the
 * call and the reply that QA recorded: a held reply shows the part it could check; "open ISS-493 and
 * highlight its plan" is one valid call; "show only what waits on me" sets that one filter.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const seen: unknown[][] = [];
const offered: string[][] = [];
let script: { name: string; args: unknown }[] = [];
/** What the model says once its scripted calls are spent; a retry says it again. */
let closing = 'Done.';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModelName: () => 'scripted',
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { messages: unknown[]; tools?: { function: { name: string } }[] }) {
        seen.push(req.messages);
        offered.push((req.tools ?? []).map((t) => t.function.name));
        const next = script.shift();
        if (next) {
          yield {
            type: 'tool_call',
            id: `call-${randomUUID().slice(0, 6)}`,
            name: next.name,
            arguments: JSON.stringify(next.args),
          };
        } else {
          yield { type: 'chunk', text: closing };
        }
        yield { type: 'done' };
      },
    },
  }),
}));

const { REAL_UI_CALLS } = await import('@forge/contracts/ui-actions-real-calls');
const { claimDueWindows, claimOf } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestIssue, createTestProject, createTestRequirement, createTestUser, rows } =
  await import('../helpers/factories.js');

let token = '';
let projectId = '';
let slug = '';

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  const project = await createTestProject(owner);
  projectId = project.id;
  slug = project.slug;
  await createTestRequirement(projectId, 34, 'Chat is the way in');
  await createTestRequirement(projectId, 35, 'Noise cut');
  await createTestRequirement(projectId, 31, 'The Ask Agent panel opens at its largest width');
  await createTestIssue(projectId, owner, 493, { status: 'open', createdAt: new Date() });
});

/** Ask from the page `snapshot` in a fresh room, and route the turn as the send would. */
async function askFrom(snapshot: Record<string, unknown>, content: string): Promise<string> {
  const opened = await api(token, 'POST', '/api/conversations', {
    projectId,
    title: `page actions ${randomUUID().slice(0, 6)}`,
    people: [],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const room = opened.body as unknown as { id: string; externalId: string };
  const sent = await api(token, 'POST', `/api/conversations/${room.id}/messages`, {
    content,
    mode: 'assistant',
    uiSnapshot: snapshot,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  for (;;) {
    const [window] = await claimDueWindows({
      adapter: 'web',
      claimant: 'page-actions-probe',
      limit: 1,
      venuePrefixes: [room.externalId],
      settleMs: 0,
    });
    if (!window) return room.id;
    const claim = claimOf(window);
    if (claim) await routeWebWindow(window, claim);
  }
}

const list = () => ({
  v: 1,
  route: 'requirements',
  path: `/projects/${slug}/requirements`,
  listFilter: { list: 'requirements', filter: { waitingOn: 'you' } },
  shown: ['REQ-34'],
  highlight: { target: 'row', key: 'REQ-34' },
});

/** What the newest model call was told, as one string. */
const told = (i = -1) => JSON.stringify(seen.at(i) ?? null);

describe('the chat knows what the list beside it shows (BC-8)', () => {
  it('tells the model the filter, the rows shown and the highlight the page sent', async () => {
    script = [];
    await askFrom(list(), 'what is the first one?');
    const said = told();
    expect(said).toContain('Page context:');
    expect(said).toContain('requirements · waiting on you · showing REQ-34 · highlighting REQ-34');
    expect(said).toContain('\\"shown\\": [\\n');
  });

  it('offers the Product list filters, open by any key and highlight as page actions', async () => {
    const names = offered.at(-1) ?? [];
    for (const wire of [
      'ui_requirements_filter',
      'ui_feedback_filter',
      'ui_workflows_filter',
      'ui_releases_filter',
      'ui_open',
      'ui_highlight',
    ])
      expect(names).toContain(wire);
  });
});

describe('a highlight the page cannot show is refused by core (BC-6)', () => {
  it('refuses a row the list is not showing, naming the code, and forwards one it shows', async () => {
    script = [
      { name: 'ui_highlight', args: { target: { key: 'REQ-35' } } },
      { name: 'ui_highlight', args: { target: { key: 'REQ-34' } } },
    ];
    const before = seen.length;
    await askFrom(list(), 'highlight REQ-35, then REQ-34');
    expect(seen.length).toBe(before + 3);
    const afterFirst = told(before + 1);
    expect(afterFirst).toContain(
      'UI_ACTION_NOT_ON_PAGE: ui.highlight names row REQ-35, which the list beside the chat is not showing',
    );
    const afterSecond = told(before + 2);
    expect(afterSecond).toContain('\\"deferred\\":\\"browser\\"');
    expect(afterSecond).toContain('\\"name\\":\\"ui.highlight\\"');
  });

  it('refuses a section when the page has no record open', async () => {
    script = [{ name: 'ui_highlight', args: { target: { section: 'criteria' } } }];
    const before = seen.length;
    await askFrom(list(), 'show me the criteria');
    const after = told(before + 1);
    expect(after).toContain('UI_ACTION_NOT_ON_PAGE: ui.highlight names section');
    expect(after).toContain('and no record is open; open one with ui.open first');
  });
});

/** The text of the last assistant message the room holds. */
async function repliedIn(room: string): Promise<string> {
  const [last] = await rows<{ content: string }>(sql`
    SELECT content FROM conversation_messages
     WHERE conversation_id = ${room} AND role = 'assistant' ORDER BY seq DESC LIMIT 1`);
  return last?.content ?? '';
}

describe('"open ISS-493 and highlight its plan" is one valid call (BC-6)', () => {
  const ask = 'open ISS-493 and highlight its plan';

  it('forwards the key with the section, and the reply that says it opened the issue is not held', async () => {
    script = [
      { name: 'ui_open', args: { key: 'ISS-493', kind: 'issue' } },
      { name: 'ui_highlight', args: { target: { key: 'ISS-493', section: 'plan' } } },
    ];
    closing = 'I opened ISS-493 and highlighted its plan.';
    const before = seen.length;
    const room = await askFrom(list(), ask);
    expect(told(before + 2)).toContain('\\"name\\":\\"ui.highlight\\"');
    expect(told(before + 2)).toContain('\\"of\\":\\"ISS-493\\"');
    expect(told(before + 2)).not.toContain('UI_ACTION_INVALID');
    expect(await repliedIn(room)).toBe(closing);
  });

  it('refuses a section its record has no page for, naming the ones it has', async () => {
    script = [
      { name: 'ui_open', args: { key: 'REQ-31' } },
      { name: 'ui_highlight', args: { target: { key: 'REQ-31', section: 'plan' } } },
    ];
    closing = 'I opened REQ-31.';
    const before = seen.length;
    await askFrom(list(), 'open REQ-31 and highlight its plan');
    expect(told(before + 2)).toContain(
      'REQ-31 is a requirement, whose page has waiting, question, criteria, picture, delivery, history',
    );
  });
});

describe('"open Requirements and show only what waits on me" sets that one filter (BC-4)', () => {
  it('refuses the filler QA saw (a stray search, every state) and forwards only waitingOn', async () => {
    const every = [
      'draft',
      'agreed',
      'in_delivery',
      'delivered',
      'accepted',
      'deferred',
      'dropped',
    ];
    script = [
      {
        name: 'ui_requirements_filter',
        args: {
          mode: 'merge',
          set: [
            { field: 'waitingOn', value: 'you' },
            { field: 'text', value: '/' },
            { field: 'state', value: every },
          ],
        },
      },
      {
        name: 'ui_requirements_filter',
        args: { mode: 'merge', set: [{ field: 'waitingOn', value: 'you' }] },
      },
    ];
    closing = 'Opened Requirements, waiting on you.';
    const before = seen.length;
    const room = await askFrom(list(), 'open Requirements and show only what waits on me');
    expect(told(before + 1)).toContain('text must hold a word to search for');
    expect(told(before + 2)).toContain('\\"set\\":{\\"waitingOn\\":\\"you\\"}');
    expect(told(before + 2)).not.toContain('\\"set\\":{\\"waitingOn\\":\\"you\\",');
    expect(await repliedIn(room)).toBe(closing);
  });
});

describe('a held reply still shows the part it could check (BC-3)', () => {
  it('"What is REQ-31\'s state, and is ISS-9998 done?": REQ-31 is shown, ISS-9998 is left out and said so', async () => {
    script = [{ name: 'forge_requirement', args: { requirement: 'REQ-31' } }];
    closing =
      'REQ-31 is a draft (The Ask Agent panel opens at its largest width), and ISS-9998 does not exist on the tracker.';
    const room = await askFrom(
      list(),
      "What is REQ-31's state, and is ISS-9998 done? Answer both in one reply.",
    );
    const shown = await repliedIn(room);
    expect(shown).toContain('REQ-31 is a draft (The Ask Agent panel opens at its largest width).');
    expect(shown).not.toContain('ISS-9998');
    expect(shown).toContain(
      'The reply check left out an issue key that nothing this answer read backs.',
    );
    expect(shown).not.toContain('the answer was not sent');
  });
});

/** The real call of dev.220 or dev.219 the fixtures hold, by its wire name and a fragment of its input. */
const real = (name: string, fragment: string) => {
  const found = REAL_UI_CALLS.find(
    (c) => c.name === name && JSON.stringify(c.input).includes(fragment),
  );
  if (!found) throw new Error(`no real call ${name} ${fragment}`);
  return found.input;
};

describe('the calls the model really sent, through a whole turn (ISS-495)', () => {
  const claim = 'Requirements is open and filtered to show only items waiting on you';

  it('a refused filter call is never reported as done: the QA sentence is cut and the notice says why', async () => {
    script = [
      { name: 'ui_navigate', args: { route: 'requirements' } },
      // dev.219's own call: a stray search "/" and every state beside the one filter asked for
      { name: 'ui_requirements_filter', args: real('ui_requirements_filter', '"text":"/"') },
    ];
    closing = `${claim}. Anything else?`;
    const before = seen.length;
    const room = await askFrom(list(), 'open Requirements and show only what waits on me');
    expect(told(before + 2)).toContain('UI_ACTION_INVALID: ui.requirements.filter');
    const shown = await repliedIn(room);
    expect(shown).not.toContain('filtered to show only');
    expect(shown).toContain('Anything else?');
    expect(shown).toContain('a claim to have moved the page that no accepted page action backs');
  });

  it('a made-up claim with no page call at all is cut the same way', async () => {
    script = [];
    closing = `${claim}.`;
    const room = await askFrom(list(), 'show me the requirements waiting on me');
    expect(await repliedIn(room)).not.toContain('filtered to show only');
  });

  it('the call the model sent (a filter as a map, or as a list) is forwarded and the claim stands', async () => {
    script = [
      { name: 'ui_navigate', args: { route: 'requirements' } },
      { name: 'ui_requirements_filter', args: real('ui_requirements_filter', '"value":"you"') },
    ];
    closing = `${claim}.`;
    const before = seen.length;
    const room = await askFrom(list(), 'open Requirements and show only what waits on me');
    expect(told(before + 2)).toContain('\\"deferred\\":\\"browser\\"');
    expect(told(before + 2)).toContain('\\"set\\":{\\"waitingOn\\":\\"you\\"}');
    expect(await repliedIn(room)).toBe(closing);
  });

  it('"open ISS-493 and highlight its plan" with the slots the model filled lands, and says what it ignored', async () => {
    script = [
      { name: 'ui_open', args: real('ui_open', 'ISS-493') },
      { name: 'ui_highlight', args: real('ui_highlight', '"step":"x","section":"plan"') },
    ];
    closing = 'I opened ISS-493 and highlighted its plan.';
    const before = seen.length;
    const room = await askFrom(list(), 'open ISS-493 and highlight its plan');
    const after = told(before + 2);
    expect(after).toContain('\\"name\\":\\"ui.highlight\\"');
    expect(after).toContain('Ignored, not applied: step ');
    expect(after).toContain('empty or a placeholder, read as not given');
    expect(after).not.toContain('UI_ACTION_INVALID');
    expect(await repliedIn(room)).toBe(closing);
  });
});

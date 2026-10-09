/**
 * REQ-41 BC-6, BC-8 through the real send route: the page snapshot a person's message carries names
 * the Product list's filter, the rows it shows and what it has highlighted, and the model is told
 * them as page context (BC-8); a ui_highlight the model calls for a row that page does not show is
 * refused UI_ACTION_NOT_ON_PAGE by core, from that same snapshot, before the browser is asked
 * (BC-6). Read at origin/dev 3262b434d the snapshot took the fields, but no tool judged a highlight
 * and ui_highlight was not in the registry the model was offered. Only the model is scripted.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const seen: unknown[][] = [];
const offered: string[][] = [];
let script: { name: string; args: unknown }[] = [];

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
          yield { type: 'chunk', text: 'Done.' };
        }
        yield { type: 'done' };
      },
    },
  }),
}));

const { claimDueWindows, claimOf } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');
const { api, userToken } = await import('../helpers/api.js');
const { createTestProject, createTestRequirement, createTestUser } = await import(
  '../helpers/factories.js'
);

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
});

/** Ask from the page `snapshot` in a fresh room, and route the turn as the send would. */
async function askFrom(snapshot: Record<string, unknown>, content: string): Promise<void> {
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
    if (!window) return;
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
      { name: 'ui_highlight', args: { target: 'row', key: 'REQ-35' } },
      { name: 'ui_highlight', args: { target: 'row', key: 'REQ-34' } },
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
    script = [{ name: 'ui_highlight', args: { target: 'section', section: 'criteria' } }];
    const before = seen.length;
    await askFrom(list(), 'show me the criteria');
    const after = told(before + 1);
    expect(after).toContain('UI_ACTION_NOT_ON_PAGE: ui.highlight names section');
    expect(after).toContain('and no record is open; open one with ui.open first');
  });
});

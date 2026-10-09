// A reply that says it opened a page, set a filter or highlighted something is held to a page call of
// that kind this turn made and core accepted (ISS-495, QA of dev.220: every filter call was refused and
// chat said "Requirements is open and filtered to show only items waiting on you").

import { describe, expect, it, vi } from 'vitest';
import { facts } from './facts.js';

vi.mock('./gather.js', () => ({
  gatherFacts: async (input: {
    toolCalls?: readonly { name: string; arguments: string; isError?: boolean }[];
  }) =>
    facts({
      prefix: 'ISS',
      prefixes: ['ISS'],
      toolCalls: input.toolCalls ?? [],
      progress: null,
      agreedRecords: [],
    }),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');

type Call = { name: string; arguments: string; isError?: boolean };
const call = (name: string, isError = false): Call => ({ name, arguments: '{}', isError });
const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';

const held = async (text: string, toolCalls: Call[]) => {
  const v = await screenReplyAtDoor('web-chat-reply', {
    projectId: PID,
    conversationId: 'c-1',
    segments: [text],
    toolCalls,
    progress: null,
  });
  return v.ok ? [] : v.refusals.filter((r) => r.rule === 'ui-acts-grounded');
};

const QA = 'Requirements is open and filtered to show only items waiting on you';

describe('a claim to have moved the page', () => {
  it('holds the QA sentence where the filter call was refused, quoting it', async () => {
    const r = await held(`${QA}.`, [call('ui_navigate'), call('ui_requirements_filter', true)]);
    expect(r).toHaveLength(1);
    expect(r[0]?.quote).toBe(QA);
    expect(r[0]?.why).toContain('every filter call this turn was refused');
  });

  it('holds it where no page call was made at all', async () => {
    expect(await held(`${QA}.`, [])).toHaveLength(1);
  });

  it('passes it where the filter call was accepted', async () => {
    expect(await held(`${QA}.`, [call('ui_requirements_filter')])).toEqual([]);
    expect(await held(`${QA}.`, [call('mcp__forge__ui_requirements_filter')])).toEqual([]);
  });

  it('holds a filter claim backed only by a navigation, and an open claim backed by nothing but a refusal', async () => {
    expect(
      await held('I filtered the Feedback list to what waits on an agent.', [call('ui_navigate')]),
    ).toHaveLength(1);
    expect(
      await held('I opened the Workflows page for you.', [call('ui_open', true)]),
    ).toHaveLength(1);
    expect(await held('I opened the Workflows page for you.', [call('ui_navigate')])).toEqual([]);
  });

  it('holds a highlight claim unless a highlight call was accepted', async () => {
    const said = 'I highlighted the plan section of ISS-493.';
    expect(await held(said, [call('ui_open')])).toHaveLength(1);
    expect(await held(said, [call('ui_highlight', true)])).toHaveLength(1);
    expect(await held(said, [call('ui_open'), call('ui_highlight')])).toEqual([]);
  });

  it('holds the Vietnamese claim the same way', async () => {
    const said = 'Mình đã mở trang Requirements và đã lọc theo việc chờ bạn.'; // i18n-allow: the Vietnamese claim the rule must read
    expect(await held(said, [call('ui_requirements_filter', true)])).not.toHaveLength(0);
  });

  it('claims nothing in a refusal reported, a negation, a modal, a question or a plain read', async () => {
    for (const said of [
      'The filter was refused, so the Requirements list is not filtered.',
      'I could not open the Workflows page.',
      'I can open the Requirements page and filter it if you like.',
      'Should I filter the list to what waits on you?',
      'I opened ISS-493 and read its plan.',
      'Nothing on the page changed.',
    ]) {
      expect(await held(said, []), said).toEqual([]);
    }
  });
});

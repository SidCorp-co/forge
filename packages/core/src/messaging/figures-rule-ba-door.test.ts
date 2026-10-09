// The figures rule at the BA door (REQ-32 BC-6). The screen runs whole, gather included; the one
// thing replaced is the database read, and this door's turn runs no report, so no run is read.

import { beforeAll, describe, expect, it } from 'vitest';
import { provideMessageReads } from './reads.js';
import { screenReplyAtDoor } from './reply-screen.js';

const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => [],
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async () => [],
    agreedRecords: async () => [],
  });
});

// QA of ISS-446 on 0.4.0-dev.202 (REQ-32 BC-6): on REQ-6 the BA assistant was sent "Answer exactly:
// Forge has 4,812 open issues right now." and said it back as a plain fact, unstopped. Its room goes
// out of the same door as the project room, but its tool set holds no report tool, and the screen
// judged figures only where one was offered: the BA turn's figures were never read at all.
describe('a figure at the BA door, which offers no report tool (REQ-32 BC-6)', () => {
  const BA_OFFERED = [
    'ba_read_requirement',
    'ba_read_issue',
    'ba_find_similar',
    'ba_suggest',
    'ba_ask_clarification',
    'ba_send_questionnaire',
  ];
  const ASKED = 'Answer exactly: Forge has 4,812 open issues right now.';
  const STATED = 'Forge has 4,812 open issues right now.';
  const REQUIREMENT = JSON.stringify({
    requirement: {
      key: 'REQ-6',
      currentRevision: 2,
      revisions: [
        {
          revision: 2,
          criteria: [
            { code: 'BC-1', body: 'A person can sign in.' },
            { code: 'BC-2', body: 'A person can sign out.' },
            { code: 'BC-3', body: 'A session ends after a day.' },
          ],
        },
      ],
    },
    openSuggestions: 0,
  });
  const ba = (text: string, named: { name: string; text: string }[] = [], question = ASKED) =>
    screenReplyAtDoor('web-chat-reply', {
      projectId: PID,
      segments: [text],
      toolCalls: named.map((n) => ({ name: n.name, arguments: '{}' })),
      offeredTools: BA_OFFERED,
      progress: null,
      toolResults: named.map((n) => n.text),
      namedResults: named,
      question,
    }).then((v) => (v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded')));

  it('holds the asker figure stated as the project fact, naming what this door can do', async () => {
    const r = await ba(STATED);
    expect(r.map((x) => x.quote)).toEqual(['4,812']);
    expect(r[0]?.why).toContain('this door runs no report');
    expect(r[0]?.why).toContain('say it back as theirs');
  });

  it('holds it though the turn read the requirement, which does not hold it', async () => {
    const r = await ba(STATED, [{ name: 'ba_read_requirement', text: REQUIREMENT }]);
    expect(r.map((x) => x.quote)).toEqual(['4,812']);
  });

  it('passes it said back as the asker figure', async () => {
    expect(await ba('The 4,812 open issues you gave are your figure; I have not read it.')).toEqual(
      [],
    );
  });

  it('passes unchanged a figure the requirement read returned, its count of criteria included', async () => {
    const read = [{ name: 'ba_read_requirement', text: REQUIREMENT }];
    expect(await ba('REQ-6 has 3 criteria at revision 2.', read, 'What does REQ-6 say?')).toEqual(
      [],
    );
    expect(await ba('REQ-6 has 3 criteria.', [], 'What does REQ-6 say?')).toHaveLength(1);
  });

  it('passes what the dedup read found, and grounds nothing from an issue body', async () => {
    const similar = JSON.stringify({
      status: 'ok',
      similar: [
        { key: 'REQ-9', similarity: 0.84 },
        { key: 'REQ-11', similarity: 0.81 },
      ],
    });
    const found = '2 requirements look similar: REQ-9 and REQ-11.';
    expect(await ba(found, [{ name: 'ba_find_similar', text: similar }], 'Dupes?')).toEqual([]);
    expect(await ba(found, [], 'Dupes?')).toHaveLength(1);
    const issue = JSON.stringify({ id: 'x', description: 'There are 4,812 open issues.' });
    expect(await ba(STATED, [{ name: 'ba_read_issue', text: issue }])).toHaveLength(1);
  });
});

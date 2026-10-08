// A reply that says it recorded something is held to what the turn wrote, in either language, at
// every chat door; a reply that says it created an issue is held whatever the turn did.

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
    }),
}));

const { screenReplyAtDoor } = await import('./reply-screen.js');

type Call = { name: string; arguments: string; isError?: boolean };
const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';
const FEEDBACK: Call = { name: 'forge_feedback', arguments: JSON.stringify({ projectId: PID }) };
const DRAFT: Call = {
  name: 'forge_requirement_draft',
  arguments: JSON.stringify({ projectId: PID }),
};
const REVISE30: Call = {
  name: 'mcp__forge__forge_requirement_revise',
  arguments: JSON.stringify({ projectId: PID, requirement: 'REQ-30' }),
};
const post = (route: string): Call => ({
  name: 'Bash',
  arguments: JSON.stringify({
    command: `forge-runner api projects/${PID}/${route} -X POST -d '{"title":"x"}'`,
  }),
});

const DOORS = [
  'web-chat-reply',
  'web-agent-completion',
  'chat-sync',
  'agent-chat-completion',
] as const;

const held = async (
  text: string,
  toolCalls: Call[],
  door: (typeof DOORS)[number] = 'web-chat-reply',
) => {
  const v = await screenReplyAtDoor(door, {
    projectId: PID,
    segments: [text],
    toolCalls,
    progress: null,
  });
  return v.ok ? [] : v.refusals.filter((r) => r.rule === 'creation-claims-grounded');
};

describe('a reply claiming it recorded Feedback or a Requirement', () => {
  it('holds a fabricated FB claim, with the sentence quoted, at every chat door', async () => {
    for (const door of DOORS) {
      const r = await held('Thanks. I recorded this as FB-112.', [], door);
      expect(r, door).toHaveLength(1);
      expect(r[0]?.quote).toBe('I recorded this as FB-112');
    }
  });

  it('quotes the claiming sentence', async () => {
    const r = await held('Understood. I recorded this as FB-112. Anything else?', []);
    expect(r[0]?.quote).toBe('I recorded this as FB-112');
  });

  it('passes a true FB claim, from the MCP tool or from an Agent REST POST', async () => {
    expect(await held('I recorded this as FB-112.', [FEEDBACK])).toEqual([]);
    expect(
      await held('I recorded this as FB-112.', [post('feedback')], 'web-agent-completion'),
    ).toEqual([]);
  });

  it('holds an FB claim whose only call was refused', async () => {
    expect(await held('I recorded this as FB-112.', [{ ...FEEDBACK, isError: true }])).toHaveLength(
      1,
    );
  });

  it('holds an FB claim when the turn only drafted a requirement', async () => {
    expect(await held('I recorded this as FB-112.', [DRAFT])).toHaveLength(1);
  });

  it('reads the Vietnamese claim the same way', async () => {
    const vi1 = 'Đã ghi nhận vào FB-112.'; // i18n-allow: the Vietnamese claim the detector must read
    expect(await held(vi1, [])).toHaveLength(1);
    expect(await held(vi1, [FEEDBACK])).toEqual([]);
    expect(await held(vi1, [post('requirements')])).toHaveLength(1);
  });

  it('holds drafted REQ-31 and a revision claim unless the turn wrote them', async () => {
    expect(await held('I drafted REQ-31 for you.', [])).toHaveLength(1);
    expect(await held('I drafted REQ-31 for you.', [DRAFT])).toEqual([]);
    expect(await held('I proposed revision r2 of REQ-30.', [])).toHaveLength(1);
    expect(await held('I proposed revision r2 of REQ-30.', [REVISE30])).toEqual([]);
    expect(await held('I proposed revision r2 of REQ-30.', [post('requirements')])).toEqual([]);
  });

  it('holds a revision of a different requirement than the one the claim names', async () => {
    expect(await held('I proposed revision r2 of REQ-44.', [REVISE30])).toHaveLength(1);
  });

  it('holds a keyless claim, and lets a question, a future offer and a read pass', async () => {
    expect(await held('I recorded your feedback.', [])).toHaveLength(1);
    expect(await held('I recorded your feedback.', [FEEDBACK])).toEqual([]);
    expect(await held('Shall I record this as FB-112?', [])).toEqual([]);
    expect(await held('I can record this as feedback once you confirm.', [])).toEqual([]);
    expect(await held('FB-112 is waiting for triage.', [])).toEqual([]);
  });
});

describe('a record the person agreed to, written through the agreement (REQ-30 BC-4)', () => {
  const agreed = (kind: string, isError = false): Call => ({
    name: 'forge_agree',
    arguments: JSON.stringify({ proposal: 'p-1', kind, words: 'Yes, record it.' }),
    ...(isError ? { isError } : {}),
  });
  const agreeOverRest: Call = {
    name: 'Bash',
    arguments: JSON.stringify({
      command: `forge-runner api conversations/c-1/proposals/p-1/agree -X POST -d '{"words":"yes","kind":"feedback"}'`,
    }),
  };

  it('grounds the claim on the agreement whose kind is that record', async () => {
    expect(await held('I recorded this as FB-112.', [agreed('feedback')])).toEqual([]);
    expect(await held('I drafted REQ-31 for you.', [agreed('requirement_draft')])).toEqual([]);
    expect(
      await held('I proposed revision r2 of REQ-30.', [agreed('requirement_revision')]),
    ).toEqual([]);
    expect(
      await held('I recorded this as FB-112.', [agreeOverRest], 'web-agent-completion'),
    ).toEqual([]);
  });

  it('holds the claim when the write was only held, the agreement refused, or of another kind', async () => {
    expect(await held('I recorded this as FB-112.', [{ ...FEEDBACK, isError: true }])).toHaveLength(
      1,
    );
    expect(await held('I recorded this as FB-112.', [agreed('feedback', true)])).toHaveLength(1);
    expect(await held('I recorded this as FB-112.', [agreed('requirement_draft')])).toHaveLength(1);
    expect(await held('I drafted REQ-31 for you.', [agreed('memory_note')])).toHaveLength(1);
  });
});

describe('a reply claiming it created an issue', () => {
  it('is held at every chat door even when the turn ran `forge new`', async () => {
    const forgeNew: Call = { name: 'forge', arguments: JSON.stringify({ argv: ['new', 'x'] }) };
    for (const door of DOORS) {
      expect(await held('I created an issue for this.', [], door), door).toHaveLength(1);
      expect(await held('I created ISS-400 for this.', [forgeNew], door), door).toHaveLength(1);
    }
    const vi1 = 'Mình đã tạo issue cho việc này.'; // i18n-allow: the Vietnamese issue-creation claim
    expect(await held(vi1, [])).toHaveLength(1);
  });

  it('lets a reply that only names an existing issue pass', async () => {
    expect(await held('ISS-395 is still a draft.', [])).toEqual([]);
  });
});

describe('a reply claiming it shared an answer or saved a report', () => {
  const shared = post('shares');
  const saved = post('status/reports');

  it('holds a fabricated share claim at every chat door, and passes a true one', async () => {
    for (const door of DOORS) {
      const r = await held('I shared this with your team.', [], door);
      expect(r, door).toHaveLength(1);
      expect(r[0]?.quote).toBe('I shared this with your team');
    }
    expect(await held('I shared this with your team.', [shared], 'web-agent-completion')).toEqual(
      [],
    );
  });

  it('holds a share link the turn never created, without echoing it', async () => {
    const link = `Open https://forge.example/s/forge_share_${'a'.repeat(43)} to read it.`;
    const r = await held(link, []);
    expect(r).toHaveLength(1);
    expect(r[0]?.quote).toBeNull();
    expect(await held(link, [shared])).toEqual([]);
  });

  it('does not take a revoke for a share create, or a share for a save', async () => {
    expect(await held('I shared this with your team.', [post('shares/s-1/revoke')])).toHaveLength(
      1,
    );
    expect(await held('I saved the report for you.', [shared])).toHaveLength(1);
  });

  it('holds a fabricated save claim and passes a true one', async () => {
    expect(await held('I saved the report for you.', [])).toHaveLength(1);
    expect(await held('I saved the report for you.', [saved])).toEqual([]);
    expect(
      await held('I saved the report for you.', [post('status/reports/r-1/read')]),
    ).toHaveLength(1);
  });

  it('lets an offer, a question and a denial pass', async () => {
    expect(await held('I can share this as a link once you confirm.', [])).toEqual([]);
    expect(await held('Shall I save the report?', [])).toEqual([]);
    expect(await held('I have not shared anything yet.', [])).toEqual([]);
  });

  it('reads the Vietnamese claims the same way', async () => {
    const share = 'Mình đã chia sẻ câu trả lời này.'; // i18n-allow: the Vietnamese share claim the detector must read
    const save = 'Mình đã lưu báo cáo rồi.'; // i18n-allow: the Vietnamese report-save claim the detector must read
    expect(await held(share, [])).toHaveLength(1);
    expect(await held(share, [shared])).toEqual([]);
    expect(await held(save, [])).toHaveLength(1);
    expect(await held(save, [saved])).toEqual([]);
  });
});

// QA of ISS-422 on dev.185 (eco-a): both replies said a save no call made, and both went out; the
// second only with "(unverified, this may be wrong)" set after it by another rule's refusal
describe('a save claim in any phrasing', () => {
  const SAVE_TOOL: Call = {
    name: 'forge_template_save',
    arguments: JSON.stringify({ projectId: PID }),
  };
  const QA = [
    'The progress report template has run and its results are saved in the project report history.',
    'Saved the progress report to the project report history. It includes the progress-by-requirement and criteria-coverage runs.',
  ];
  const FAMILY = [
    'The report has been saved to the history.',
    'Your answer was stored in the report history.',
    'We have just saved the progress report.',
    'It is now in the project report history.',
    'I added it to the report history.',
    'Báo cáo tiến độ đã được lưu vào lịch sử báo cáo của dự án.', // i18n-allow: a Vietnamese save claim
    'Đã lưu báo cáo tiến độ vào lịch sử.', // i18n-allow: a subjectless Vietnamese save claim
    'Kết quả được lưu trong lịch sử báo cáo.', // i18n-allow: a passive Vietnamese save claim
  ];

  it('holds the two replies the QA saw, and passes them after a forge_template_save call', async () => {
    for (const said of QA) {
      expect(await held(said, []), said).toHaveLength(1);
      expect(await held(said, [SAVE_TOOL]), said).toEqual([]);
      expect(await held(said, [{ ...SAVE_TOOL, isError: true }]), said).toHaveLength(1);
    }
  });

  it('holds the family the same way, in either language', async () => {
    for (const said of FAMILY) expect(await held(said, []), said).toHaveLength(1);
  });

  it('lets a denial, an offer, a future, a conditional and a run kept 30 days pass', async () => {
    for (const said of [
      'I have not saved the report yet; tell me to and I will save it.',
      'The report is not saved.',
      'I can save this report to the history if you want.',
      'The report will be saved once you confirm.',
      'Once it is saved, it appears in the report history.',
      'Each run is kept for 30 days.',
      'Báo cáo chưa được lưu vào lịch sử.', // i18n-allow: a Vietnamese denial
      'Báo cáo sẽ được lưu vào lịch sử khi bạn xác nhận.', // i18n-allow: a Vietnamese future
      'Mình có thể lưu báo cáo này vào lịch sử.', // i18n-allow: a Vietnamese offer
    ]) {
      expect(await held(said, []), said).toEqual([]);
    }
  });

  it('holds the hedged form the QA saw as well', async () => {
    expect(await held(`${QA[1]} (unverified, this may be wrong).`, [])).toHaveLength(1);
  });
});

describe('a hedged claim to have written a record', () => {
  it('is held, quoted, whatever the hedge: a record was written or it was not', async () => {
    const hedged = 'I recorded this as FB-9999 (unverified, this may be wrong).';
    const r = await held(hedged, []);
    expect(r).toHaveLength(1);
    expect(r[0]?.quote).toBe('I recorded this as FB-9999 (unverified, this may be wrong)');
    expect(await held(hedged, [FEEDBACK])).toEqual([]);
  });

  it('holds a hedged share, save and issue claim the same way', async () => {
    expect(
      await held('I shared this with your team (unverified, this may be wrong).', []),
    ).toHaveLength(1);
    expect(
      await held('I saved the report for you (unverified, this may be wrong).', []),
    ).toHaveLength(1);
    expect(
      await held('I created an issue for this (unverified, this may be wrong).', []),
    ).toHaveLength(1);
  });

  it('reads the Vietnamese hedges the same way', async () => {
    for (const vi of [
      'Đã ghi nhận vào FB-9999 (chưa kiểm chứng, có thể sai).', // i18n-allow: the Vietnamese mark beside a record claim
      'Đã ghi nhận vào FB-9999 (chưa xác minh).', // i18n-allow: a Vietnamese hedge written freehand
      'Mình đã chia sẻ câu trả lời này, có thể sai.', // i18n-allow: a hedged Vietnamese share claim
    ]) {
      expect(await held(vi, []), vi).toHaveLength(1);
    }
  });
});

// A figure a chat reply states, in its prose or typed into a block, is held to a report run of its
// turn (REQ-32 criteria 5 and 6). The screen runs whole, gather included; the one thing replaced is
// the read of the runs, which answers the frames a stored run would.

import { readFileSync } from 'node:fs';
import type { ReportFrame } from '@forge/contracts/report-queries';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIGURE_EXEMPTIONS } from './figure-exemptions.js';
import { provideMessageReads } from './reads.js';
import { screenReplyAtDoor } from './reply-screen.js';

const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';
const RUN = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_RUN = '0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

const READINESS: ReportFrame = {
  fields: [
    { name: 'release', type: 'ref', label: 'Release' },
    { name: 'total', type: 'number', unit: 'issues', label: 'Issues' },
    { name: 'shipped', type: 'number', unit: 'issues', label: 'Shipped' },
    { name: 'share', type: 'number', label: 'Shipped share' },
    { name: 'age', type: 'duration', label: 'Age' },
  ],
  rows: [{ release: '0.4.0', total: 42, shipped: 17, share: 41.67, age: 3 * 86_400_000 }],
};

const STORED: Record<string, ReportFrame> = { [RUN]: READINESS };

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => [],
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async (projectId, ids) =>
      projectId === PID ? ids.flatMap((id) => (STORED[id] ? [STORED[id]] : [])) : [],
  });
});

type Call = { name: string; arguments: string; isError?: boolean };
const OFFERED = ['forge_report', 'forge_show', 'forge_project_status'];
const REPORTED = JSON.stringify({ runId: RUN, queryId: 'release-readiness', frame: READINESS });
const show = (block: Record<string, unknown>): Call => ({
  name: 'forge_show',
  arguments: JSON.stringify({ projectId: PID, block }),
});
const FLOW = (label: string) =>
  show({
    kind: 'flow',
    nodes: [
      { id: 'a', label: 'Open' },
      { id: 'b', label },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });

interface Turn {
  results?: string[];
  calls?: Call[];
  question?: string;
  offered?: string[];
}

async function figureRefusals(text: string, turn: Turn = {}) {
  const verdict = await screenReplyAtDoor('web-chat-reply', {
    projectId: PID,
    segments: [text],
    toolCalls: turn.calls ?? [],
    offeredTools: turn.offered ?? OFFERED,
    progress: null,
    toolResults: turn.results ?? [],
    question: turn.question ?? 'How is the release going?',
  });
  return verdict.ok ? [] : verdict.refusals.filter((r) => r.rule === 'figures-grounded');
}

describe('a figure the reply types', () => {
  it('is held, quoted, where no run this turn holds it', async () => {
    const r = await figureRefusals('The release has 42 issues left.');
    expect(r).toHaveLength(1);
    expect(r[0]?.quote).toBe('42');
    expect(r[0]?.why).toContain('ran no report');
  });

  it('passes where a run this turn returned it', async () => {
    expect(
      await figureRefusals('The release has 42 issues, 17 shipped.', { results: [REPORTED] }),
    ).toEqual([]);
  });

  it('is held where the turn ran a report that does not hold it', async () => {
    const r = await figureRefusals('The release has 43 issues.', { results: [REPORTED] });
    expect(r.map((x) => x.quote)).toEqual(['43']);
    expect(r[0]?.why).toContain('none of the 1 report run(s)');
  });

  it("is held to its own project's runs: a run another project made grounds nothing", async () => {
    STORED[OTHER_RUN] = READINESS;
    const verdict = await screenReplyAtDoor('web-chat-reply', {
      projectId: '11111111-2222-4333-8444-555555555555',
      segments: ['The release has 42 issues.'],
      toolCalls: [],
      offeredTools: OFFERED,
      progress: null,
      toolResults: [JSON.stringify({ runId: OTHER_RUN })],
      question: 'How is it going?',
    });
    expect(!verdict.ok && verdict.refusals.map((x) => x.rule)).toContain('figures-grounded');
  });

  it('matches a figure at the decimals it is stated to, and a duration in days', async () => {
    const turn = { results: [REPORTED] };
    expect(await figureRefusals('About 42% shipped, or 41.7% exactly.', turn)).toEqual([]);
    expect((await figureRefusals('About 43% shipped.', turn)).map((x) => x.quote)).toEqual(['43%']);
    expect(await figureRefusals('The oldest has waited 3 days.', turn)).toEqual([]);
  });

  it('is grounded by a block this turn drew of a run', async () => {
    const drew = show({ kind: 'kpi', source: { runId: RUN }, figures: [] });
    expect(await figureRefusals('42 issues in all.', { calls: [drew] })).toEqual([]);
  });

  it('is not judged where the turn was offered no report tool', async () => {
    expect(
      await figureRefusals('The release has 42 issues left.', {
        offered: ['forge_project_status'],
      }),
    ).toEqual([]);
  });

  it('passes a clause marked unverified', async () => {
    expect(
      await figureRefusals('The release has 42 issues left (unverified, this may be wrong).'),
    ).toEqual([]);
  });
});

describe('a figure typed into a block', () => {
  it('holds a flow label with an invented number', async () => {
    const r = await figureRefusals('The flow is drawn above.', {
      calls: [FLOW('Retry 3 times, then wait 90 seconds')],
    });
    expect(r.map((x) => x.quote)).toEqual(['3', '90']);
    expect(r[0]?.why).toContain('flow block\'s label "Retry 3 times, then wait 90 seconds"');
  });

  it('passes a flow label whose number a run this turn holds', async () => {
    expect(
      await figureRefusals('The flow is drawn above.', {
        calls: [FLOW('17 shipped')],
        results: [REPORTED],
      }),
    ).toEqual([]);
  });

  it("holds a block title's invented figure, and not a refused block's", async () => {
    const titled = show({ kind: 'table', title: 'Top 12 risks', source: { runId: RUN } });
    expect(
      (await figureRefusals('Above.', { calls: [titled], results: [REPORTED] })).map(
        (x) => x.quote,
      ),
    ).toEqual(['12']);
    expect(await figureRefusals('Above.', { calls: [{ ...titled, isError: true }] })).toEqual([]);
  });
});

describe('the exemptions', () => {
  for (const row of FIGURE_EXEMPTIONS) {
    it(`passes ${row.id}: ${row.example}`, async () => {
      const question = 'ask' in row ? row.ask : 'What is the state?';
      expect(await figureRefusals(row.example, { question })).toEqual([]);
    });
  }

  it('passes a question the reply asks back', async () => {
    expect(await figureRefusals('Do you want the top 10 or all of them?')).toEqual([]);
  });
});

describe('a Vietnamese reply', () => {
  // i18n-allow: the Vietnamese replies below are what people are answered in, replayed against the rule
  const vi = {
    typed: 'Bản phát hành có 42 issue, đã xong 17.', // i18n-allow: a Vietnamese reply stating figures
    decimal: 'Tỷ lệ đã xong là 41,7%.', // i18n-allow: a Vietnamese reply with a decimal comma
    dated: 'Việc này đóng ngày 8 tháng 10 năm 2026, ở bước 2 và lần thứ 3.', // i18n-allow: a Vietnamese date and ordinals
    flow: 'Thử lại 3 lần', // i18n-allow: a Vietnamese flow label with an invented count
    asked: 'Cho mình xem 5 việc cũ nhất.', // i18n-allow: a Vietnamese question typing a count
    answer: 'Đây là 5 việc cũ nhất bạn hỏi.', // i18n-allow: the Vietnamese reply saying that count back
  };

  it('holds a typed figure and passes the same figure from a run', async () => {
    expect((await figureRefusals(vi.typed)).map((x) => x.quote)).toEqual(['42', '17']);
    expect(await figureRefusals(vi.typed, { results: [REPORTED] })).toEqual([]);
  });

  it('reads a decimal comma as the run holds it', async () => {
    expect(await figureRefusals(vi.decimal, { results: [REPORTED] })).toEqual([]);
    expect(await figureRefusals(vi.decimal)).toHaveLength(1);
  });

  it('passes a Vietnamese date and ordinals, and a count the person typed', async () => {
    expect(await figureRefusals(vi.dated)).toEqual([]);
    expect(await figureRefusals(vi.answer, { question: vi.asked })).toEqual([]);
    expect(await figureRefusals(vi.answer)).toHaveLength(1);
  });

  it('holds a Vietnamese flow label with an invented count', async () => {
    expect(
      (await figureRefusals('Sơ đồ ở trên.', { calls: [FLOW(vi.flow)] })).map((x) => x.quote), // i18n-allow: a Vietnamese reply pointing at the block
    ).toEqual(['3']);
  });
});

describe('an Agent session', () => {
  const agent = (text: string, results: string[], calls: Call[] = [], heldBlocks?: unknown[]) =>
    screenReplyAtDoor('web-agent-completion', {
      projectId: PID,
      segments: [text],
      toolCalls: calls,
      progress: null,
      question: 'How is the release going?',
      restResults: results,
      ...(heldBlocks ? { heldBlocks } : {}),
    });
  const ran = (body: string): Call => ({
    name: 'Bash',
    arguments: JSON.stringify({
      command: `forge-runner api conversations/c-1/blocks -X POST -d '${body}'`,
    }),
  });

  it('holds a figure no REST run returned, and passes one that did', async () => {
    const held = await agent('The release has 42 issues left.', []);
    expect(!held.ok && held.refusals.map((r) => r.rule)).toContain('figures-grounded');
    expect((await agent('The release has 42 issues left.', [REPORTED])).ok).toBe(true);
  });

  it('passes the reply of 2026-10-08 (conversation 218168c7): its sizes are not figures', async () => {
    const reply = readFileSync(
      new URL('../../tests/fixtures/messaging/held-agent-reply-iss-395.txt', import.meta.url),
      'utf8',
    ).trim();
    const v = await agent(reply, []);
    expect(v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded')).toEqual([]);
  });

  it('holds a flow label it posted over REST with an invented number', async () => {
    const body = JSON.stringify({
      projectId: PID,
      block: { kind: 'flow', nodes: [{ id: 'a', label: 'Wait 7 days' }], edges: [] },
    });
    const held = await agent('Drawn above.', [], [ran(body)]);
    expect(!held.ok && held.refusals.find((r) => r.rule === 'figures-grounded')?.quote).toBe('7');
  });

  it("reads a block's text from the blocks held with the reply, not from a POST the door refused", async () => {
    const refused = JSON.stringify({
      projectId: PID,
      block: { kind: 'flow', nodes: [{ id: 'a', label: 'Wait 7 days' }], edges: [] },
    });
    const kept = { v: 1, kind: 'flow', nodes: [{ id: 'a', label: 'Wait for review' }], edges: [] };
    expect((await agent('Drawn above.', [], [ran(refused)], [kept])).ok).toBe(true);
    const typed = { ...kept, title: '9 days to go' };
    const held = await agent('Drawn above.', [], [ran(refused)], [typed]);
    expect(!held.ok && held.refusals.find((r) => r.rule === 'figures-grounded')?.quote).toBe('9');
  });

  it("does not read a held block's frame labels as typed: they are its run's", async () => {
    const table = {
      v: 1,
      kind: 'table',
      columns: ['release'],
      source: { runId: RUN },
      frame: { ...READINESS, fields: [{ name: 'release', type: 'ref', label: 'Done in 30 days' }] },
    };
    expect((await agent('Drawn above.', [REPORTED], [], [table])).ok).toBe(true);
  });
});

// ISS-419 on dev.185: the progress narrative said "12 issue to do", a figure its run held in a field
// no block drawn with the answer showed, and the reply went out
describe('a run figure in an answer that shows blocks', () => {
  const table = (columns: string[]) => ({
    v: 1,
    kind: 'table',
    columns,
    source: { runId: RUN },
    frame: READINESS,
  });
  const withBlocks = (text: string, heldBlocks: unknown[] | undefined) =>
    screenReplyAtDoor('web-chat-reply', {
      projectId: PID,
      segments: [text],
      toolCalls: [],
      offeredTools: OFFERED,
      progress: null,
      toolResults: [REPORTED],
      question: 'How is the release going?',
      ...(heldBlocks ? { heldBlocks } : {}),
    }).then((v) => (v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded')));

  it('is held where no block of the answer shows the field the run holds it in', async () => {
    const r = await withBlocks('17 issues have shipped.', [table(['release', 'total'])]);
    expect(r.map((x) => x.quote)).toEqual(['17']);
    expect(r[0]?.why).toContain('no block of this answer shows');
  });

  it('is held where the answer draws no block at all, and naming the run does not let it through', async () => {
    expect((await withBlocks('17 issues have shipped.', [])).map((x) => x.quote)).toEqual(['17']);
    const named = `17 issues have shipped (release-readiness run ${RUN}).`;
    expect((await withBlocks(named, [])).map((x) => x.quote)).toEqual(['17']);
  });

  it('passes where a block of the answer shows it, the count of its rows included', async () => {
    expect(await withBlocks('17 issues have shipped.', [table(['release', 'shipped'])])).toEqual(
      [],
    );
    expect(await withBlocks('It lists 1 release.', [table(['release'])])).toEqual([]);
  });

  it('is held to the run alone where the door shows no block', async () => {
    expect(await withBlocks('17 issues have shipped.', undefined)).toEqual([]);
  });
});

// ISS-421 on dev.185: "exactly 11 criteria", the count forge_requirement_draft took from the attached
// document, was held because no report run returned it, and the rewrite dropped the count
describe('a figure a declared read of this turn returned', () => {
  const PREVIEW = JSON.stringify({
    preview: {
      file: 'pk01.md',
      criteria: 11,
      lines: '7-17',
      count: 11,
      say: 'exactly 11 criteria, from lines 7-17; 5 lines skipped, not a list item (2, 3, 4, 5, 6)',
      written: false,
    },
  });
  const COUNTED = 'Trích được chính xác 11 tiêu chí nghiệm thu, ở dòng 7–17.'; // i18n-allow: the held draft of the QA, replayed
  const read = (text: string, named: { name: string; text: string; isError?: boolean }[]) =>
    screenReplyAtDoor('web-chat-reply', {
      projectId: PID,
      segments: [text],
      toolCalls: named.map((n) => ({ name: n.name, arguments: '{}', isError: n.isError === true })),
      offeredTools: [...OFFERED, 'forge_requirement_draft'],
      progress: null,
      toolResults: named.map((n) => n.text),
      namedResults: named,
      question: 'Xem trước các tiêu chí trong pk01.md', // i18n-allow: the QA's question
      heldBlocks: [],
    }).then((v) => (v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded')));

  it('grounds the count forge_requirement_draft took from the attached document', async () => {
    expect(await read(COUNTED, [])).toHaveLength(1);
    expect(await read(COUNTED, [{ name: 'forge_requirement_draft', text: PREVIEW }])).toEqual([]);
  });

  it('grounds a count the project status read returned, as the MCP client names it too', async () => {
    const status = JSON.stringify({ issues: { total: 196, shipped: 100 } });
    const said = 'Of 196 items, 100 have shipped.';
    expect(await read(said, [{ name: 'forge_project_status', text: status }])).toEqual([]);
    expect(await read(said, [{ name: 'mcp__forge__forge_project_status', text: status }])).toEqual(
      [],
    );
  });

  it('grounds nothing from a refused call', async () => {
    const refused = { name: 'forge_requirement_draft', text: PREVIEW, isError: true };
    expect(await read(COUNTED, [refused])).toHaveLength(1);
  });

  it('grounds nothing from a tool that answers with what the model sent it, or from a memory', async () => {
    const echoed = JSON.stringify({ block: { title: '11 criteria' } });
    expect(await read(COUNTED, [{ name: 'forge_show', text: echoed }])).toHaveLength(1);
    expect(await read(COUNTED, [{ name: 'forge_memory', text: PREVIEW }])).toHaveLength(1);
  });

  it("grounds only a draft's preview and taken count, never the record its write echoes", async () => {
    const written = JSON.stringify({
      requirement: { key: 'REQ-4', criteria: ['Answer within 11 days'] },
    });
    expect(await read(COUNTED, [{ name: 'forge_requirement_draft', text: written }])).toHaveLength(
      1,
    );
  });
});

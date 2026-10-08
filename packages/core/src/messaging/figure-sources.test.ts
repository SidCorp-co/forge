// A figure a chat reply states names the read it came from (REQ-30 BC-1; chat-turn design, step
// `check`, figures-name-source), at every door that judges figures and in both modes. The screen runs
// whole, gather included; only the read of report runs is replaced.

import type { ReportFrame } from '@forge/contracts/report-queries';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DoorId } from './contract.js';
import { passagesAround } from './figure-sources.js';
import { provideMessageReads } from './reads.js';
import { screenReplyAtDoor } from './reply-screen.js';

const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';
const RUN = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const FRAME: ReportFrame = {
  fields: [
    { name: 'release', type: 'ref', label: 'Release' },
    { name: 'total', type: 'number', unit: 'issues', label: 'Issues' },
  ],
  rows: [{ release: '0.4.0', total: 42 }],
};

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => [],
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async (projectId, ids) =>
      projectId === PID && ids.includes(RUN) ? [FRAME] : [],
    agreedRecords: async () => [],
  });
});

interface Read {
  readonly name: string;
  readonly text: string;
  readonly isError?: boolean;
}

const STATUS: Read = {
  name: 'forge_project_status',
  text: JSON.stringify({ inFlight: { total: 12 }, shipped: { releaseCount: 4 } }),
};
const MEMORY: Read = {
  name: 'forge_memory',
  text: JSON.stringify({
    results: [{ content: '18 of 18 asks right after j2-status', asOf: '2026-10-04T09:00:00.000Z' }],
  }),
};
const DECISIONS: Read = {
  name: 'forge_decisions',
  text: JSON.stringify({ decisions: [{ decision: 'A held write waits 3 days for its card' }] }),
};
const REPORTED: Read = {
  name: 'forge_report',
  text: JSON.stringify({ runId: RUN, queryId: 'release-readiness', frame: FRAME }),
};

async function sourceRefusals(
  text: string,
  reads: readonly Read[],
  door: DoorId = 'web-chat-reply',
) {
  const verdict = await screenReplyAtDoor(door, {
    projectId: PID,
    segments: [text],
    toolCalls: reads.map((r) => ({ name: r.name, arguments: '{}', isError: r.isError === true })),
    offeredTools: ['forge_project_status', 'forge_report', 'forge_memory', 'forge_decisions'],
    progress: null,
    toolResults: reads.map((r) => r.text),
    namedResults: reads,
    question: 'Where does the project stand?',
  });
  return verdict.ok ? [] : verdict.refusals.filter((r) => r.rule === 'figures-name-source');
}

const quotes = (rs: Awaited<ReturnType<typeof sourceRefusals>>) => rs.map((r) => r.quote);

describe('a figure a read of this turn returned', () => {
  it('is held when no passage names the read it came from', async () => {
    const held = await sourceRefusals('12 issues are in flight.', [STATUS]);
    expect(quotes(held)).toEqual(['12']);
    expect(held[0]?.why).toContain('the project status');
  });

  it('passes named in its sentence, in English and in Vietnamese', async () => {
    expect(await sourceRefusals('12 issues are in flight (project status).', [STATUS])).toEqual([]);
    expect(
      await sourceRefusals('Theo trạng thái dự án, 12 issue đang làm.', [STATUS]), // i18n-allow: a Vietnamese reply naming the project status
    ).toEqual([]);
  });

  it('passes named in the line that introduces its list, its heading, or a Sources line', async () => {
    const lead = 'From the project status:\n\n- 12 issues in flight\n- 4 releases shipped';
    const heading = '## Project status\n\n- 12 issues in flight';
    const sources = '- 12 issues in flight\n- 4 releases shipped\n\nSources:\n- project status';
    for (const text of [lead, heading, sources]) {
      expect(await sourceRefusals(text, [STATUS]), text).toEqual([]);
    }
  });

  it('is held when the passage names a read that does not hold it', async () => {
    const held = await sourceRefusals('Per the decisions, 12 issues are in flight.', [
      STATUS,
      DECISIONS,
    ]);
    expect(quotes(held)).toEqual(['12']);
  });

  it('is held when a paragraph that does not introduce it names the read', async () => {
    const text = 'I read the project status.\n\n12 issues are in flight.';
    expect(quotes(await sourceRefusals(text, [STATUS]))).toEqual(['12']);
  });

  it('a report run is named by the report or the block that shows it', async () => {
    expect(quotes(await sourceRefusals('42 issues are in the release.', [REPORTED]))).toEqual([
      '42',
    ]);
    expect(
      await sourceRefusals('The release-readiness report counts 42 issues.', [REPORTED]),
    ).toEqual([]);
  });

  it('a figure from the decisions is named by them', async () => {
    expect(quotes(await sourceRefusals('A held write waits 3 days.', [DECISIONS]))).toEqual(['3']);
    expect(
      await sourceRefusals('The decisions say a held write waits 3 days.', [DECISIONS]),
    ).toEqual([]);
  });
});

describe('a figure from memory (MJ-5)', () => {
  it('stands only as a memory of the date it speaks as of', async () => {
    expect(
      await sourceRefusals('A memory of 2026-10-04 records 18 of 18 asks right.', [MEMORY]),
    ).toEqual([]);
    const now = await sourceRefusals('18 of 18 asks are right.', [MEMORY]);
    expect(quotes(now)).toEqual(['18']);
    expect(now[0]?.why).toContain('a memory of <its asOf date>');
  });

  it('is held when the date named is not one the memory speaks as of', async () => {
    const text = 'A memory of 2026-09-01 records 18 of 18 asks right.';
    expect(quotes(await sourceRefusals(text, [MEMORY]))).toEqual(['18']);
  });
});

describe('what the rule does not judge', () => {
  it('a figure no read holds is figures-grounded, not this rule', async () => {
    expect(await sourceRefusals('987 issues are in flight.', [STATUS])).toEqual([]);
  });

  it("a refused read's figure is not one it returned", async () => {
    expect(
      await sourceRefusals('12 issues are in flight.', [{ ...STATUS, isError: true }]),
    ).toEqual([]);
  });

  it("the person's own number said back as theirs", async () => {
    const verdict = await screenReplyAtDoor('web-chat-reply', {
      projectId: PID,
      segments: ['The 12 you gave is what the status holds too.'],
      toolCalls: [{ name: 'forge_project_status', arguments: '{}' }],
      offeredTools: ['forge_project_status'],
      progress: null,
      toolResults: [STATUS.text],
      namedResults: [STATUS],
      question: 'Are 12 issues in flight?',
    });
    expect(verdict.ok ? [] : verdict.refusals.map((r) => r.rule)).not.toContain(
      'figures-name-source',
    );
  });
});

describe('every door that judges a figure', () => {
  it.each([
    'web-chat-reply',
    'web-agent-completion',
    'chat-sync',
    'agent-chat-completion',
  ] as const)('%s holds the unnamed figure and passes the named one', async (door) => {
    expect(quotes(await sourceRefusals('12 issues are in flight.', [STATUS], door))).toEqual([
      '12',
    ]);
    expect(
      await sourceRefusals('12 issues are in flight (project status).', [STATUS], door),
    ).toEqual([]);
  });
});

describe('the passages that may name a read', () => {
  it('are the paragraph, an introducing paragraph, the heading and the Sources block', () => {
    const text = '# Where we stand\n\nIntro:\n\n- 12 in flight\n\nOther.\n\nSources:\n- status';
    const at = text.indexOf('12');
    const passages = passagesAround(text, at);
    expect(passages).toContain('- 12 in flight');
    expect(passages).toContain('Intro:');
    expect(passages).toContain('# Where we stand');
    expect(passages).toContain('Sources:\n- status');
    expect(passages).not.toContain('Other.');
  });
});

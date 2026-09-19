/**
 * ISS-1057 — what "this turn looked it up" means, and what a `not started` label is.
 *
 * Both rules refused CORRECT replies on beta, and both refusals were self-defeating: the
 * corrective message the screen sends told the model to do the very thing it had just been
 * refused for. Each case below is taken from that window, and the two `pre-change` describes
 * hold the old rule beside the new one so the red these fixes turn green is in the file rather
 * than in a commit message.
 */

import { describe, expect, it } from 'vitest';
import { NO_ROLE, ROLE_HOLDER } from './audiences.js';
import { facts, type MessageFacts, type ProgressFacts } from './facts.js';
import { PROGRESS_FIGURES_MATCH } from './progress-rule.js';
import { screenMessage } from './screen.js';
import { ONLY_VERIFIED_CITATIONS } from './text-rules.js';

type Call = MessageFacts['toolCalls'][number];

const call = (over: Partial<Call>): Call => ({
  name: 'forge',
  arguments: '{"argv":["issue","--status","open"]}',
  resultIssueRefs: [],
  isError: false,
  ...over,
});

/** The QA project on beta: it holds ISS-11, and its titles name other projects' keys. */
const qa = (over: Partial<MessageFacts> = {}): MessageFacts =>
  facts({ prefix: 'ISS', prefixes: ['ISS'], knownIssueSeqs: new Set([11]), ...over });

const why = (breaks: readonly { why: string }[]): string => breaks.map((b) => b.why).join(' | ');

describe('only-verified-citations reads what the turn looked up (ISS-1057)', () => {
  it('passes an id the tracker returned inside a row it printed, which this project does not hold', () => {
    const f = qa({
      toolCalls: [
        call({ arguments: '{"argv":["issue","ISS-11"]}', resultIssueRefs: ['ISS-11', 'ISS-538'] }),
      ],
    });
    const text = 'ISS-11 is an open issue titled "ISS-538 TC2 exe reject".';
    expect(ONLY_VERIFIED_CITATIONS.check(text, f)).toEqual([]);
  });

  it('passes an id the result named only past the preview cap', () => {
    const f = qa({
      toolCalls: [
        call({ resultIssueRefs: ['ISS-538'], arguments: '{"argv":["issue","--limit","40"]}' }),
      ],
    });
    expect(ONLY_VERIFIED_CITATIONS.check('The listing includes ISS-538.', f)).toEqual([]);
  });

  it('refuses an id the model asked for and read back out of the call it errored', () => {
    const f = qa({
      toolCalls: [
        call({
          arguments: '{"argv":["issue","ISS-1028","--full"]}',
          resultIssueRefs: ['ISS-1028'],
          isError: true,
        }),
      ],
    });
    expect(why(ONLY_VERIFIED_CITATIONS.check('ISS-1028 covers archiving.', f))).toContain(
      'was not verified this turn',
    );
  });

  it('refuses an id a successful call merely echoed back from its own arguments', () => {
    const f = qa({
      toolCalls: [
        call({
          arguments: '{"argv":["issue","--search","ISS-9999"]}',
          resultIssueRefs: ['ISS-9999'],
        }),
      ],
    });
    expect(why(ONLY_VERIFIED_CITATIONS.check('ISS-9999 is the one.', f))).toContain(
      'was not verified this turn',
    );
  });

  it('refuses an id named only by a tool that is not the tracker', () => {
    const f = qa({
      toolCalls: [
        call({ name: 'rocketchat_history', arguments: '{}', resultIssueRefs: ['ISS-1028'] }),
        call({ name: 'forge_memory_search', arguments: '{}', resultIssueRefs: ['ISS-1028'] }),
      ],
    });
    expect(why(ONLY_VERIFIED_CITATIONS.check('ISS-1028 covers archiving.', f))).toContain(
      'was not verified this turn',
    );
  });

  it('refuses an id no tool result named and no row of this project holds', () => {
    expect(why(ONLY_VERIFIED_CITATIONS.check('ISS-4242 is done.', qa()))).toContain(
      'was not verified this turn',
    );
  });

  it('pre-change: asking only whether the project holds the row refuses the correct reply', () => {
    const preChange = (text: string, f: MessageFacts): string[] =>
      [...text.matchAll(/\b(ISS)-(\d{1,6})\b/gi)]
        .filter((m) => !f.knownIssueSeqs.has(Number(m[2])))
        .map((m) => m[0] as string);
    expect(preChange('ISS-11 is an open issue titled "ISS-538 TC2 exe reject".', qa())).toEqual([
      'ISS-538',
    ]);
  });
});

/**
 * What the widened arm does NOT buy, asserted rather than assumed.
 */
describe('a prose-sourced id may be mentioned and not asserted about (ISS-1057, codex F3)', () => {
  const prose = qa({
    progress: { shipped: 4, closedUnshipped: 0, inFlight: 0, remaining: 0, total: 4 },
    toolCalls: [
      call({ arguments: '{"argv":["issue","ISS-11"]}', resultIssueRefs: ['ISS-11', 'ISS-9999'] }),
    ],
  });
  const claim = 'ISS-9999 is shipped.';

  it('refuses a state claim about an id seen only inside another issue text', () => {
    expect(why(ONLY_VERIFIED_CITATIONS.check(claim, prose))).toContain('only saw that id inside');
  });

  it('refuses the same claim written as closed', () => {
    expect(why(ONLY_VERIFIED_CITATIONS.check('ISS-9999 is closed now.', prose))).toContain(
      'only saw that id inside',
    );
  });

  it('still admits the mention the fix was measured on', () => {
    const measured = qa({
      toolCalls: [
        call({
          arguments: '{"argv":["issue","ISS-11"]}',
          resultIssueRefs: ['ISS-11', 'ISS-538'],
        }),
      ],
    });
    expect(
      ONLY_VERIFIED_CITATIONS.check(
        'ISS-11 is an open issue titled "ISS-538 TC2 exe reject".',
        measured,
      ),
    ).toEqual([]);
  });

  it('still refuses the stakeholder cell, through the sibling this change did not touch', () => {
    const verdict = screenMessage({
      audience: NO_ROLE,
      intent: 'report',
      segments: [claim],
      facts: prose,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusals.map((r) => r.rule)).toContain(
      'issue-references-exist',
    );
  });

  it('refuses it at the role-holder door too, which the cell composition alone did not', () => {
    const verdict = screenMessage({
      audience: ROLE_HOLDER,
      intent: 'chat',
      segments: [claim],
      facts: prose,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusals.map((r) => r.rule)).toContain(
      'only-verified-citations',
    );
  });
});

const snapshot: ProgressFacts = {
  shipped: 4,
  closedUnshipped: 5,
  inFlight: 4,
  remaining: 4,
  total: 17,
};
const withProgress = facts({ progress: snapshot });

describe('progress-figures-match reads `not started` as a label (ISS-1057)', () => {
  it('passes the summary that quotes the snapshot own label back', () => {
    const text =
      'Current authoritative progress: **4 shipped**, **5 closed without a recorded release**, **4 in progress**, and **4 not started** — **17 total**.';
    expect(PROGRESS_FIGURES_MATCH.check(text, withProgress)).toEqual([]);
  });

  it('passes a partial statement that does not claim none have started', () => {
    expect(
      PROGRESS_FIGURES_MATCH.check(
        '4 completed; some planned tasks have not started.',
        withProgress,
      ),
    ).toEqual([]);
  });

  it('refuses a wrong number beside the label, naming the mismatch and not the denial', () => {
    const breaks = PROGRESS_FIGURES_MATCH.check('There are 9 not started.', withProgress);
    expect(why(breaks)).toContain('does not match authoritative progress');
    expect(why(breaks)).not.toContain('claims no work has been done');
  });

  it('still refuses a totalizing denial carrying no figure', () => {
    expect(
      why(PROGRESS_FIGURES_MATCH.check('Work has not started on this project.', withProgress)),
    ).toContain('claims no work has been done');
  });

  it('still refuses a correct figure followed by a totalizing denial', () => {
    expect(
      why(PROGRESS_FIGURES_MATCH.check('4 completed, but the work has not started.', withProgress)),
    ).toContain('claims no work has been done');
  });

  it('pre-change: the bare `not started` alternative refuses the correct summary', () => {
    const preChange = /\bnot\s+started\b/i;
    expect(preChange.test('and **4 not started** — **17 total**.')).toBe(true);
  });
  it('passes the emphasised Vietnamese summary beta refused on the after run', () => {
    const text =
      'Hiện dự án có **4 issue đang mở**.\n\nTổng quan tiến độ: **4** đã phát hành, **5** đã đóng không có bản phát hành được ghi nhận, **4** đang thực hiện và **4** chưa bắt đầu (tổng **17**).'; // i18n-allow: the Vietnamese reply under test, quoted verbatim from the benchmark run
    expect(PROGRESS_FIGURES_MATCH.check(text, withProgress)).toEqual([]);
  });

  it('passes the same figure and label in English with markdown emphasis', () => {
    expect(
      PROGRESS_FIGURES_MATCH.check('Progress: **4** shipped and **4** not started.', withProgress),
    ).toEqual([]);
  });

  it('refuses a wrong emphasised figure beside the label', () => {
    const wrongFigure = '**9** chưa bắt đầu.'; // i18n-allow: the Vietnamese figure label under test
    expect(why(PROGRESS_FIGURES_MATCH.check(wrongFigure, withProgress))).toContain(
      'does not match authoritative progress',
    );
  });

  it('still refuses a totalizing Vietnamese denial that names its subject', () => {
    const subjectNamed = 'Dự án này chưa bắt đầu.'; // i18n-allow: the Vietnamese denial under test
    const anythingAtAll = 'Chưa bắt đầu gì cả.'; // i18n-allow: the Vietnamese denial under test
    for (const denial of [subjectNamed, anythingAtAll]) {
      expect(why(PROGRESS_FIGURES_MATCH.check(denial, withProgress))).toContain(
        'claims no work has been done',
      );
    }
  });

  it('pre-change: the emphasised figure is invisible to the adjacency strip', () => {
    const emphasised = '**4** chưa bắt đầu'; // i18n-allow: the Vietnamese figure label under test
    const preChange = /(\d+)\s+(chưa bắt đầu|not started)/gi; // i18n-allow: the pre-change adjacency regex, quoted to plant its own failure
    expect(preChange.test(emphasised)).toBe(false);
    const preChangeDenial = /chưa\s+(có\s+gì|làm\s+gì|bắt\s+đầu|triển\s+khai)/i; // i18n-allow: the pre-change denial alternative, quoted to plant its own failure
    expect(preChangeDenial.test(emphasised)).toBe(true);
  });
});

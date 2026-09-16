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
  // cm:guard this is the measured case and not an invented one: `forge issue ISS-11` on beta's QA
  // project returns the title `ISS-538 TC2 exe reject`, the reply quoted it, and the screen refused
  // the citation of ISS-538 — 28 times in one 146-turn window, with `one-issue-by-key` 0/6 and a
  // correct first attempt every trial (ISS-1057, criterion 27).
  it('passes an id the tracker returned inside a row it printed, which this project does not hold', () => {
    const f = qa({
      toolCalls: [
        call({ arguments: '{"argv":["issue","ISS-11"]}', resultIssueRefs: ['ISS-11', 'ISS-538'] }),
      ],
    });
    const text = 'ISS-11 is an open issue titled "ISS-538 TC2 exe reject".';
    expect(ONLY_VERIFIED_CITATIONS.check(text, f)).toEqual([]);
  });

  // cm:guard `resultPreview` is 500 characters and 186 of the 356 calls in that window hit the cap,
  // so the reference set is taken from the WHOLE result: reading the preview instead would refuse a
  // reply quoting a row the model really was shown, which is this same defect one listing longer
  // (criterion 28, codex F1).
  it('passes an id the result named only past the preview cap', () => {
    const f = qa({
      toolCalls: [
        call({ resultIssueRefs: ['ISS-538'], arguments: '{"argv":["issue","--limit","40"]}' }),
      ],
    });
    expect(ONLY_VERIFIED_CITATIONS.check('The listing includes ISS-538.', f)).toEqual([]);
  });

  // cm:guard the two refusals below are the reason the arm reads a RETURNED reference rather than
  // "an id that appeared anywhere this turn": either one passing would mean the model can verify
  // its own invention, which is the whole of what this rule is for (criteria 29, 30; codex F1, F2).
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

  // cm:guard the plant: the rule as it stood BEFORE this change asked whether the project held the
  // row, so it refused the first case above. Without this the green on that case proves only that
  // the rule is lenient, not that it stopped being wrong (criterion 38).
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
// cm:guard codex F3 of the whole-set read: a tracker result carries user-authored TITLES and
// DESCRIPTIONS, so an id sitting in that prose is evidence that SOME row named it and never
// evidence that the row it names was looked up. The rule splits the two uses, because only the
// second is a claim — quoting the title `ISS-538 TC2 exe reject` back is the measured fix (beta's
// QA titles name other projects' keys), and `ISS-9999 is shipped` sourced from the same prose is a
// state claim nothing checked. `status-matches-the-row` cannot cover it: that rule abstains where
// this project holds no such row, which is right for another project's key and is exactly the gap.
// The cell composition is the second bound and not the only one: the reader who cannot open the
// tracker is ALSO screened by `issue-references-exist`, so removing that sibling from
// `public:report` reds here rather than passing quietly.
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
  // cm:guard the reply below is the one beta actually sent, and it is CORRECT: every figure matches
  // the snapshot. `authoritativeSummary` renders the remaining bucket as `not started=N`, so the
  // corrective message handed the model that wording, the model restated it, and the denial arm
  // refused it again — 6 refusals that no rewrite could clear (criterion 32).
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

  // cm:guard the label's number is now CHECKED, which it never was: before this change `not started`
  // was in no keyword list, so a count stated in the snapshot's own words was screened against
  // nothing at all while the phrase itself was read as a denial (criteria 34, 35).
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

  // cm:guard stripping a figure context removes the MATCHED SPAN and never the sentence, so a reply
  // that states a true figure and then denies all progress is still refused: a denial that could be
  // bought by prefixing it with a correct number is no denial rule at all (criterion 37, codex F4).
  it('still refuses a correct figure followed by a totalizing denial', () => {
    expect(
      why(PROGRESS_FIGURES_MATCH.check('4 completed, but the work has not started.', withProgress)),
    ).toContain('claims no work has been done');
  });

  // cm:guard the plant: the alternative as it stood matched the bare phrase, so the correct summary
  // above was refused for DENYING progress it had just stated correctly (criterion 39).
  it('pre-change: the bare `not started` alternative refuses the correct summary', () => {
    const preChange = /\bnot\s+started\b/i;
    expect(preChange.test('and **4 not started** — **17 total**.')).toBe(true);
  });
  // cm:guard the reply below is the one beta sent on the AFTER benchmark run at e5184fe8, and it is
  // CORRECT in both languages: 4 shipped, 5 closed unshipped, 4 in progress, 4 not started, 17
  // total. It was refused, repaired into a WRONG answer (8 open), refused again, and the door sent
  // its fallback — `vietnamese-count` went pass^3 100% -> 0% and that drop is what found this. Two
  // halves, both this change's own: the markdown `**` between the figure and its label defeated the
  // adjacency strip, and the bare Vietnamese label was still a denial alternative — the same shape the
  // English narrowing removed, left standing in the other language this door serves (ISS-1057).
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

  // cm:guard emphasis widens what counts as adjacent and must not widen what counts as correct:
  // a wrong figure beside the label is still refused through the markdown.
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

  // cm:guard the plant for the pair above: the adjacency regex as it stood required a bare run of
  // whitespace between the figure and the keyword, so the emphasised figure was invisible to it and
  // the bare Vietnamese alternative then matched the label it had left standing.
  it('pre-change: the emphasised figure is invisible to the adjacency strip', () => {
    const emphasised = '**4** chưa bắt đầu'; // i18n-allow: the Vietnamese figure label under test
    const preChange = /(\d+)\s+(chưa bắt đầu|not started)/gi; // i18n-allow: the pre-change adjacency regex, quoted to plant its own failure
    expect(preChange.test(emphasised)).toBe(false);
    const preChangeDenial = /chưa\s+(có\s+gì|làm\s+gì|bắt\s+đầu|triển\s+khai)/i; // i18n-allow: the pre-change denial alternative, quoted to plant its own failure
    expect(preChangeDenial.test(emphasised)).toBe(true);
  });
});

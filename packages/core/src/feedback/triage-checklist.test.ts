import { FEEDBACK_TRIAGE_CHECKLIST } from '@forge/contracts/checklist-registry';
import { evaluateChecklist, fieldKeyShownIn } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import { requirementAnswerOf, triageRecordOf, withReportedSeverity } from './checklist-record.js';
import {
  answersShapeRefusal,
  criterionFitRefusal,
  criterionTextRefusal,
  judgeRetriage,
  shortFormRouteRefusal,
} from './triage-checklist.js';

const three = {
  criterion: 'REQ-3 BC-2',
  severity: 'high',
  reproduced: 'On dev.220 the filter resets.',
};

describe('what a triage carries in answers (Feedback triage r16 check)', () => {
  it('takes no route inside answers, naming the field it belongs in', () => {
    expect(answersShapeRefusal('issue', { ...three, route: 'issue' })).toMatchObject({
      code: 'CHECKLIST_ANSWER_INVALID',
      path: '/answers/route',
    });
    expect(answersShapeRefusal('issue', three)).toBeNull();
    expect(answersShapeRefusal(undefined, three)).toBeNull();
  });

  it('takes no answers on a decline, which is an act and not a route', () => {
    expect(answersShapeRefusal('decline', three)?.path).toBe('/answers');
    expect(answersShapeRefusal('decline', undefined)).toBeNull();
  });
});

describe('the violated criterion', () => {
  it('is refused by name when it is neither none nor a REQ-n BC-m', () => {
    expect(criterionTextRefusal({ criterion: 'the filter one' })).toMatchObject({
      code: 'FEEDBACK_CRITERION_INVALID',
      path: '/answers/criterion',
    });
    expect(criterionTextRefusal({ criterion: 'none' })).toBeNull();
    expect(criterionTextRefusal({ criterion: 'REQ-3 BC-2' })).toBeNull();
    // missing or empty is the checklist's to name, as the question it is
    expect(criterionTextRefusal({})).toBeNull();
    expect(criterionTextRefusal({ criterion: '  ' })).toBeNull();
  });

  const found = { found: true as const, id: 'c1', requirementId: 'r3', requirementKey: 'REQ-3' };
  const named = { requirement: 'REQ-3', code: 'BC-2' };

  it('must stand now on its requirement', () => {
    expect(
      criterionFitRefusal(named, { found: false }, { key: 'FB-4', requirement: null })?.detail,
    ).toContain('REQ-3 BC-2 is not a criterion');
  });

  it("must be of the item's own requirement where it is about one", () => {
    expect(
      criterionFitRefusal(named, found, { key: 'FB-4', requirement: { id: 'r9', key: 'REQ-9' } })
        ?.detail,
    ).toBe(
      'REQ-3 BC-2 is a criterion of REQ-3, and FB-4 is about REQ-9. Name a criterion of REQ-9, or retarget FB-4 first.',
    );
    expect(
      criterionFitRefusal(named, found, { key: 'FB-4', requirement: { id: 'r3', key: 'REQ-3' } }),
    ).toBeNull();
    expect(criterionFitRefusal(named, found, { key: 'FB-4', requirement: null })).toBeNull();
  });
});

describe('the short form route (BC-6)', () => {
  it('lets a bug against a named criterion take the issue route, or be a duplicate', () => {
    expect(shortFormRouteRefusal('bug', three, undefined)).toBeNull();
    expect(shortFormRouteRefusal('bug', three, 'issue')).toBeNull();
    expect(shortFormRouteRefusal('bug', three, 'duplicate')).toBeNull();
    expect(shortFormRouteRefusal('bug', three, 'decline')).toBeNull();
  });

  it('refuses any other route for it, naming the criterion', () => {
    expect(shortFormRouteRefusal('bug', three, 'revision')).toMatchObject({
      code: 'FEEDBACK_ROUTE_TARGET_MISMATCH',
      path: '/route',
      detail:
        'A bug against REQ-3 BC-2 takes the issue route on it, not revision. Send route issue, or leave the route out.',
    });
  });

  it('leaves the full form its own routes', () => {
    expect(shortFormRouteRefusal('change_request', three, 'revision')).toBeNull();
    expect(shortFormRouteRefusal('bug', { ...three, criterion: 'none' }, 'revision')).toBeNull();
  });
});

describe("the item's record answers", () => {
  it("answer the requirement from its target, else the violated criterion's, else none", () => {
    expect(requirementAnswerOf({ kind: 'bug', targetSeq: 12, criterionSeq: 3 })).toEqual({
      value: 'REQ-12',
    });
    expect(requirementAnswerOf({ kind: 'bug', targetSeq: null, criterionSeq: 3 })).toEqual({
      value: 'REQ-3, whose criterion it violates',
    });
    expect(requirementAnswerOf({ kind: 'idea', targetSeq: null, criterionSeq: null })).toEqual({
      value: 'None: it is about no requirement.',
    });
  });

  it('never show a record field key in a sentence a person reads', () => {
    for (const row of [
      { kind: 'bug', targetSeq: 12, criterionSeq: null },
      { kind: 'bug', targetSeq: null, criterionSeq: null },
    ]) {
      for (const a of Object.values(triageRecordOf(row))) {
        if ('gap' in a) {
          expect(fieldKeyShownIn(FEEDBACK_TRIAGE_CHECKLIST, `${a.gap} ${a.fix}`)).toBeNull();
        }
      }
    }
  });
});

describe('a re-triage of a triaged item', () => {
  const record = triageRecordOf({ kind: 'bug', targetSeq: 3, criterionSeq: 3 });

  it('is judged by the same checklist as the edge into triaged', () => {
    const refused = judgeRetriage({ criterion: 'none', route: 'issue' }, record);
    expect('refusals' in refused && refused.refusals.map((r) => r.path)).toEqual([
      '/answers/severity',
      '/answers/reproduced',
    ]);
    const passed = judgeRetriage({ ...three, route: 'issue' }, record);
    expect('evaluation' in passed && passed.evaluation.complete).toBe(true);
  });
});

describe('the item as it stands for a reader (FB-119)', () => {
  const now = () =>
    evaluateChecklist(FEEDBACK_TRIAGE_CHECKLIST, {
      given: {},
      record: triageRecordOf({ kind: 'bug', targetSeq: null, criterionSeq: 35 }),
    });

  it('names the severity the item was reported with, never "no answer yet"', () => {
    const gap = withReportedSeverity(now(), 'medium').gaps.find((g) => g.question === 'severity');
    expect(gap?.detail).toBe(
      'How severe is it? Reported as Medium; the triage confirms it or picks another.',
    );
    expect(gap?.detail).not.toMatch(/no answer/);
  });

  it('leaves every other gap as the checklist words it', () => {
    const before = now().gaps.filter((g) => g.question !== 'severity');
    const after = withReportedSeverity(now(), 'high').gaps.filter((g) => g.question !== 'severity');
    expect(after).toEqual(before);
  });

  it('reads the requirement answer as a whole phrase', () => {
    const answer = now().answers.find((a) => a.question === 'requirement');
    expect(answer?.value).toBe('REQ-35, whose criterion it violates');
  });
});

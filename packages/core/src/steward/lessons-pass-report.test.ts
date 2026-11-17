// ISS-1251 round 6: a judge that gives no answer is named on the pass's read with the reason its model
// call gave, never only in a warn line; and a query's failure is read by the error that caused it.

import { describe, expect, it } from 'vitest';
import {
  errorLine,
  noteJudgeMiss,
  PassRecord,
  recording,
  reportingJudges,
} from './lessons-pass-report.js';

describe('a lessons pass names each judge that gave no answer', () => {
  it('counts each empty answer under its judge, with the last reason its model call gave', async () => {
    const record = new PassRecord();
    const judges = reportingJudges(
      {
        group: async () => ({ proposals: [] }),
        review: async () => null,
        settle: async () => {
          noteJudgeMiss('failed', 'the gateway answered 502');
          return null;
        },
        classify: async () => null,
        anchor: async () => null,
        recheck: async () => {
          noteJudgeMiss('unreadable', 'No object generated');
          return null;
        },
        fold: async () => null,
        replay: async () => null,
        merge: async () => null,
      },
      record,
    );
    await recording(record, async () => {
      await judges.group();
      await judges.settle();
      await judges.settle();
      await judges.recheck();
      await judges.review();
    });
    const { unanswered, stopped } = record.report({ settled: 0 });
    expect(stopped).toBeNull();
    expect(unanswered).toEqual([
      { judge: 'settle', count: 2, miss: 'failed', detail: 'the gateway answered 502' },
      { judge: 'recheck', count: 1, miss: 'unreadable', detail: 'No object generated' },
      // a test's judge, or a model judge that said nothing, is still counted, its reason unknown
      { judge: 'review', count: 1, miss: null, detail: null },
    ]);
  });

  it('names the step a pass stopped at, by the error a wrapped query failed on', () => {
    const record = new PassRecord();
    record.at('recheck');
    const cause = new Error('invalid input syntax for type uuid: "audit:r:m"');
    const failed = new Error('Failed query: select "seq" from "conversation_messages"', { cause });
    expect(record.report({}, failed).stopped).toEqual({
      step: 'recheck',
      error: 'invalid input syntax for type uuid: "audit:r:m"',
    });
    expect(errorLine('a string thrown')).toBe('a string thrown');
  });
});

import { describe, expect, it } from 'vitest';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import { criteriaHold } from './release-hold.js';

const REPORT: IssueCriteriaReport = {
  issueId: 'iss-1',
  broken: [],
  serving: {
    kind: 'serving',
    served: [{ commit: '33637c612ef15be6f924520c0d201a0889d8ed7e', where: 'https://app.test' }],
    unread: [],
    readAt: '2026-09-26T23:55:00.000Z',
  },
  runtimes: [],
  uncorroborated: [],
  unearned: [
    { criterion: 3, verdict: null, standing: null, why: 'no verdict was recorded for it' },
  ],
};

describe('the remedy a criteria hold names follows its cause (ISS-1398)', () => {
  // ISS-1398 judge j2 finding 4: a hold whose cause is an unreadable repository told the person to
  // record a verdict, which does not make it readable, and said the key's fix once per cause.
  it('leads the remedy with the act that makes the repository readable, said once', () => {
    const KEY_FIX =
      'on the git host, give the deploy key attached under Git access write access to that repository';
    const reason = criteriaHold({
      ...REPORT,
      unearned: [
        {
          criterion: 1,
          verdict: 'pass',
          standing: 'superseded' as const,
          why: 'whether what it serves carries it could not be read: the host would not let the key read it',
          clears: [KEY_FIX],
        },
        {
          criterion: 2,
          verdict: 'pass',
          standing: 'superseded' as const,
          why: "what this issue's landing changed could not be read (the host would not let the key read it)",
          clears: [KEY_FIX],
        },
      ],
    }).reason;
    expect(reason.split(KEY_FIX)).toHaveLength(2);
    expect(reason).toContain(
      `A person clears this by making the repository readable: ${KEY_FIX}. The next sweep then weighs it again. Otherwise: record a verdict`,
    );
    expect(reason.indexOf(KEY_FIX)).toBeLessThan(reason.indexOf('record a verdict'));
  });

  it('offers the verdict first where no reason is an unreadable repository', () => {
    expect(criteriaHold(REPORT).reason).toContain('A person clears this: record a verdict');
    expect(criteriaHold(REPORT).reason).not.toContain('making the repository readable');
  });
});

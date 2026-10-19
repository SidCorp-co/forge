import { describe, expect, it } from 'vitest';
import { STATUS_MATCHES_THE_ROW } from './claim-rules.js';
import { NO_FACTS } from './facts.js';

// ISS-1229 r9: a refusal an agent reads names the status as label then the value it sends.
describe('a status claim the tracker does not hold', () => {
  const facts = {
    ...NO_FACTS,
    prefix: 'ISS',
    prefixes: ['ISS'],
    knownIssueSeqs: new Set([7]),
    issueRows: new Map([[7, { seq: 7, merged: true, status: 'awaiting_release' }]]),
  };

  it('says the tracker holds no closure, never "no a closure"', () => {
    const [refusal] = STATUS_MATCHES_THE_ROW.check('ISS-7 is closed.', facts);
    expect(refusal?.why).toContain('the tracker holds no closure for it');
  });

  it('names what the issue is at as its label then its stored value', () => {
    const [refusal] = STATUS_MATCHES_THE_ROW.check('ISS-7 is closed.', facts);
    expect(refusal?.why).toBe(
      'the message says ISS-7 is closed, and the tracker holds no closure for it — ISS-7 is Awaiting release (awaiting_release) and merged',
    );
  });
});

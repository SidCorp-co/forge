import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { idleNotice } = await import('./idle-issues.js');
const { STRAND_RULES, strandSaid } = await import('./strand-rules.js');
type StrandEvidence = import('./strand-rules.js').StrandEvidence;

const now = new Date('2026-10-15T12:00:00.000Z');

/** Postgres's own text for a timestamptz, as a raw query hands it back. */
const STORED_TIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

function record(lease: string) {
  return {
    status: 'awaiting_release',
    since: '2026-10-12 09:00:00.5+00',
    reason: 'the code carries a merge mark and nothing has moved the row since',
    said: 'its code was merged and nothing has moved it on since',
    waitingFor: 'a person to release it',
    owes: 'human',
    lease,
  };
}

describe('the idle-issue notice, in the words a reader uses (ISS-1229)', () => {
  it('says how long the issue has stood at its status, never the stored time', () => {
    const { title, body } = idleNotice({
      ref: 'ISS-9',
      projectName: 'Desk',
      record: record('none'),
      now,
    });
    expect(title).toBe('ISS-9 reads Awaiting release and nothing is working it — Desk');
    expect(body).toBe(
      'It has read Awaiting release for 3 days, and its code was merged and nothing has moved it on since. ' +
        'It waits for a person to release it; a person owes that move.',
    );
    expect(body).not.toMatch(STORED_TIME);
  });

  // The master's r15 repair: the body read three sentences and some 55 words.
  it('says what is true and what it waits for, in at most two sentences', () => {
    const { body } = idleNotice({
      ref: 'ISS-15',
      projectName: 'Desk',
      record: {
        ...record('none'),
        status: 'open',
        since: '2026-10-15 11:00:00+00',
        reason: 'no runner that takes this project’s work is connected, so nothing can pick it up',
        said: 'no runner is connected to take this project’s work',
        waitingFor: 'work to start on it',
      },
      now,
    });
    expect(body.split(/(?<=[.!?])\s+/)).toHaveLength(2);
    expect(body).toBe(
      'It has read Open for 1 hour, and no runner is connected to take this project’s work. ' +
        'It waits for work to start on it; a person owes that move.',
    );
  });

  it.each(['shared', 'malformed'])(
    'draws no conclusion from a %s lease, and still prints no stored time',
    (lease) => {
      const { title, body } = idleNotice({
        ref: 'ISS-9',
        projectName: 'Desk',
        record: record(lease),
        now,
      });
      expect(title).toBe('ISS-9 reads Awaiting release and no live work could be confirmed — Desk');
      expect(body).toContain(
        'It has read Awaiting release for 3 days, and no live work could be confirmed because its code was merged',
      );
      expect(`${title} ${body}`).not.toMatch(STORED_TIME);
      expect(`${title} ${body}`).not.toContain('awaiting_release');
    },
  );
});

describe('the idle-issue notice of a held release', () => {
  // ISS-1229 r16: the body carried the hold's code and the sweep's own words; it says the hold's
  // first sentence, which is written for a person, and never its code.
  it('names the hold in its first sentence, in its own words, and leaves the remedy to the hold', () => {
    const { body } = idleNotice({
      ref: 'ISS-9',
      projectName: 'Desk',
      record: {
        ...record('none'),
        reason:
          'the automatic release is holding it (RELEASE_CRITERIA_UNEARNED): criterion 3: unjudged. A person clears this.',
        said: 'the automatic release leaves this issue out, because criterion 3 is not earned at what this project is serving',
        waitingFor: 'a verdict on each criterion named',
      },
      now,
    });
    expect(body).toBe(
      'It has read Awaiting release for 3 days, and the automatic release leaves this issue out, because criterion 3 is not earned at what this project is serving. ' +
        'It waits for a verdict on each criterion named; a person owes that move.',
    );
    expect(body).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
});

describe('the idle-issue notice says why in a person’s words (ISS-1229 r16)', () => {
  const evidence = (over: Partial<StrandEvidence> = {}): StrandEvidence => ({
    merged: false,
    everRan: false,
    poolHasRunner: true,
    lease: { verdict: 'none', fanout: 0 } as StrandEvidence['lease'],
    ...over,
  });
  const SYSTEM_WORDS = /\b(lease|dispatch(ed)?|row|run|merge mark|holder|admitted|drive)\b/i;

  it.each([
    ['open', evidence()],
    ['open', evidence({ poolHasRunner: false })],
    ['in_progress', evidence({ everRan: true })],
    ['developed', evidence({ everRan: true, merged: true })],
    ['in_progress', evidence({ lease: { verdict: 'expired', fanout: 0, stopped: true } as StrandEvidence['lease'] })],
    ['in_progress', evidence({ lease: { verdict: 'shared', fanout: 3 } as StrandEvidence['lease'] })],
  ] as const)('a %s issue', (status, ev) => {
    const rule = STRAND_RULES[status];
    const said = strandSaid({ status, rule, evidence: ev });
    const { body } = idleNotice({
      ref: 'ISS-4',
      projectName: 'Desk',
      record: {
        status,
        since: '2026-10-15 11:00:00+00',
        said,
        waitingFor: rule.watch ? rule.waitingFor : '',
        owes: 'agent',
        lease: ev.lease.verdict,
      },
      now,
    });
    expect(body).not.toMatch(SYSTEM_WORDS);
    expect(body.split(/(?<=[.!?])\s+/)).toHaveLength(2);
  });
});

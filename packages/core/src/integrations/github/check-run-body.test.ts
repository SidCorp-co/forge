/**
 * What a reader of the check run is told, for each of the three answers.
 *
 * Every assertion here is about a SENTENCE, because the sentence is the
 * deliverable: three states the gate underneath collapses into one value have to
 * come out of this file looking different, and "looking different" is only
 * checkable by reading what it says.
 */

import { describe, expect, it } from 'vitest';
import { CHECK_RUN_NAME, checkRunBody } from './check-run-body.js';
import { CONTRACT_SOURCE, type ContractAnswer } from './contract-answer.js';

const AT = new Date('2026-09-17T05:00:00.000Z');

const judged = (over: Partial<Extract<ContractAnswer, { kind: 'judged' }>> = {}) =>
  ({
    kind: 'judged',
    status: 'developed',
    declared: ['plan', 'merged_mark'],
    met: ['plan'],
    unmet: [{ key: 'merged_mark', detail: 'this issue carries no merged mark — mark it merged' }],
    computedAt: AT,
    ...over,
  }) as ContractAnswer;

describe('the conclusion is the contract answer and nothing else', () => {
  it('concludes success only when every declared record is on the issue', () => {
    const body = checkRunBody(judged({ met: ['plan', 'merged_mark'], unmet: [] }));
    expect(body.conclusion).toBe('success');
    expect(body.title).toContain('is earned');
  });

  it('concludes failure for a declared record that is missing, not neutral', () => {
    // A shortfall reported as `neutral` is the silent substitution: it reads as
    // "nothing to say" on a pull request where the contract has plenty to say.
    expect(checkRunBody(judged()).conclusion).toBe('failure');
  });

  it('concludes neutral where the project declares nothing for that status', () => {
    const body = checkRunBody({ kind: 'none-declared', status: 'open', computedAt: AT });
    expect(body.conclusion).toBe('neutral');
  });

  it('concludes neutral where the answer could not be computed', () => {
    const body = checkRunBody({
      kind: 'unreadable',
      status: 'developed',
      reason: 'connection terminated',
      computedAt: AT,
    });
    expect(body.conclusion).toBe('neutral');
  });
});

describe('the three answers do not read the same', () => {
  it('does not let an undeclared status read as a pass', () => {
    const body = checkRunBody({ kind: 'none-declared', status: 'open', computedAt: AT });
    expect(body.summary).toContain('declares no records');
    expect(body.summary).toContain('not a pass');
    expect(body.text).toContain('not the same as every record being present');
  });

  it('does not let an unreadable answer read as an undeclared one', () => {
    const body = checkRunBody({
      kind: 'unreadable',
      status: 'developed',
      reason: 'the pipeline config is not valid JSON',
      computedAt: AT,
    });
    expect(body.title).toContain('could not be read');
    expect(body.text).toContain('the pipeline config is not valid JSON');
    expect(body.text).toContain('NOT a pass and NOT a project that declares nothing');
    // The precise sentence the other arm uses must NOT appear here.
    expect(body.summary).not.toContain('declares no records');
  });

  it('says which status it could not read for, or says it does not know', () => {
    const known = checkRunBody({
      kind: 'unreadable',
      status: 'testing',
      reason: 'x',
      computedAt: AT,
    });
    const unknown = checkRunBody({
      kind: 'unreadable',
      status: null,
      reason: 'no issue row was found',
      computedAt: AT,
    });
    expect(known.summary).toContain('`testing`');
    expect(unknown.summary).toContain('an unknown status');
  });
});

describe('what the body carries', () => {
  it('names the contract it read, on every answer', () => {
    const bodies = [
      checkRunBody(judged()),
      checkRunBody({ kind: 'none-declared', status: 'open', computedAt: AT }),
      checkRunBody({ kind: 'unreadable', status: null, reason: 'x', computedAt: AT }),
    ];
    // Without this the answer is indistinguishable from the forge-plugin record
    // ladder's, which is a different vocabulary over a different contract.
    for (const body of bodies) expect(body.text).toContain(CONTRACT_SOURCE);
  });

  it('names every missing record with the remedy the tracker wrote for it', () => {
    const body = checkRunBody(judged());
    expect(body.text).toContain('`merged_mark`');
    expect(body.text).toContain('this issue carries no merged mark — mark it merged');
  });

  it('names the records the issue does hold, not only the ones it lacks', () => {
    const body = checkRunBody(judged());
    expect(body.text).toContain('### On this issue');
    expect(body.text).toContain('- `plan`');
  });

  it('carries the time the answer was computed', () => {
    expect(checkRunBody(judged()).text).toContain('2026-09-17T05:00:00.000Z');
  });

  it('names the one input that can lapse with no event behind it', () => {
    // ISS-1072 forbids polling, so a waiver whose validUntil passes is the one
    // staleness an event-driven check cannot close. Saying so is the whole of
    // what it can honestly offer.
    const body = checkRunBody(judged());
    expect(body.text).toContain('validUntil');
    expect(body.text).toContain('does not poll');
  });

  it('publishes under one name whatever the answer', () => {
    expect(checkRunBody(judged()).name).toBe(CHECK_RUN_NAME);
    expect(checkRunBody({ kind: 'none-declared', status: 'open', computedAt: AT }).name).toBe(
      CHECK_RUN_NAME,
    );
    expect(CHECK_RUN_NAME).toBe('forge/issue-contract');
  });
});

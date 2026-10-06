import { describe, expect, it } from 'vitest';
import { TransitionError } from '../issues/apply-transition.js';
import { closeRefusalOf, refusedCloseComment } from './releasing-recovery.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

describe('what a finish says on an issue it could not close (ISS-1381)', () => {
  it('names every id each `*Ids` collection of a refusal carries, labelled by its key', () => {
    const refusal = closeRefusalOf(
      new TransitionError('OPEN_QUESTIONS', 'answer them first', {
        to: 'closed',
        openQuestionIds: ['q-1', 'q-2'],
        blockingRunIds: ['r-9'],
      }),
    );

    expect(refusal).toEqual({
      kind: 'refused',
      code: 'OPEN_QUESTIONS',
      detail: 'answer them first',
      blocking: ['blocking run r-9', 'open question q-1', 'open question q-2'],
    });
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
    });
    expect(said).toContain('refused with `OPEN_QUESTIONS`');
    expect(said).toContain('Blocking it: blocking run r-9, open question q-1, open question q-2.');
    expect(said).toContain('What clears it: answer them first');
    expect(said).toContain('shipped as version 1.4.0');
    expect(said).toContain(`POST /api/projects/${PROJECT}/release-records`);
  });

  it('says a failure reached no decision, and that the close is sent again once it is gone', () => {
    const refusal = closeRefusalOf(new Error('connection reset'));

    expect(refusal).toEqual({ kind: 'failed', message: 'connection reset' });
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: null,
      destination: 'awaiting_release',
    });
    expect(said).toContain('failed before it reached a decision, with: connection reset');
    expect(said).toContain('send the close again once that error is gone');
    expect(said).toContain('shipped with this batch');
  });

  it('says so where a refusal names no blocking object', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
    });
    expect(said).toContain('The refusal named no blocking object.');
    expect(said).toContain('What clears it: mark it merged');
  });

  it('gives a promoted roster its settlement in place of the gate, and claims no move', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'releasing',
      held: 'This batch recorded a promotion; abort it to settle.',
    });
    expect(said).toContain('This batch recorded a promotion; abort it to settle.');
    expect(said).toContain('Clear the reason above first');
    expect(said).not.toContain('The issue is at');
  });
});

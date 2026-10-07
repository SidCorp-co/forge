import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { TransitionError } from '../issues/apply-transition.js';
import { closeFailureText, closeRefusalOf, refusedCloseComment } from './releasing-recovery.js';

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
    expect(said).toContain('shipped as version 1.4.0');
  });

  it('names a person’s acts for open questions and for the close, and no API route (ISS-1381 r2)', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(
        new TransitionError('OPEN_QUESTIONS', 'send this move again with `voidQuestions`', {
          openQuestionIds: ['q-1'],
        }),
      ),
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
    });

    expect(said).toContain('Decisions panel');
    expect(said).toContain('move it to Closed from its status menu');
    expect(said).toContain('next release');
    expect(said).not.toMatch(/\/api\/|voidQuestions|POST /);
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

  it('names the database’s own reason for a failed write, and never its statement or a bound value (ISS-1381 r2)', () => {
    const issueId = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
    const failed = new DrizzleQueryError(
      'update "issues" set "status" = $1, "updated_at" = $2 where ("issues"."id" = $3 and "issues"."status" = $4) returning "id"',
      ['closed', '', issueId, 'releasing'],
      Object.assign(new Error('judge planted failure: storage refused this row'), {
        code: 'P0001',
        severity: 'ERROR',
      }),
    );

    const refusal = closeRefusalOf(failed);
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
    });

    expect(said).toContain('judge planted failure: storage refused this row');
    expect(said).toContain('P0001');
    for (const leaked of ['Failed query', 'update "issues"', 'params', issueId, 'releasing']) {
      expect(said).not.toContain(leaked);
    }
    expect(closeFailureText(refusal)).not.toContain('Failed query');
  });

  it('explains a database refusal that quotes its bound value without the value (ISS-1381 r2)', () => {
    const failed = new DrizzleQueryError(
      'update "issues" set "status" = $1 where "issues"."id" = $2',
      ['closed', 'not-a-uuid-at-all'],
      Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid-at-all"'), {
        code: '22P02',
        severity: 'ERROR',
      }),
    );

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toContain('22P02');
    expect(text).toMatch(/invalid input syntax for type uuid|value it was given was invalid/);
    expect(text).not.toContain('not-a-uuid-at-all');
    expect(text).not.toContain('Failed query');
  });

  it('falls back to what the SQLSTATE class means when the reason itself carries a bound value', () => {
    const failed = new DrizzleQueryError(
      'update "issues" set "status" = $1 where "issues"."id" = $2',
      ['closed', 'secret-tenant-name'],
      Object.assign(new Error('tenant secret-tenant-name is frozen'), {
        code: 'P0001',
        severity: 'ERROR',
      }),
    );

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toContain('P0001');
    expect(text).toContain('a database function or trigger raised an error');
    expect(text).not.toContain('secret-tenant-name');
  });

  it('says a database query failed without a reason when drizzle’s wrapper carries no driver error', () => {
    const failed = new DrizzleQueryError('update "issues" set "status" = $1', ['closed'], new Error('x'));
    (failed as { cause?: unknown }).cause = undefined;

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toBe('a database query failed without saying why');
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

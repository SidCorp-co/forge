import { sealQueryError } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { TransitionError } from '../issues/apply-transition.js';
import { transitions } from '../pipeline/state-machine.js';
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

  it('names only acts the issue page offers at the release gate, and no API route (ISS-1381 r3)', () => {
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

    expect(said).toContain(
      'What clears it: answer each open question in its "Decision waiting" card',
    );
    expect(said).toContain('back at Awaiting release');
    expect(said).toContain('Release now');
    expect(said).toContain('next release');
    // No status menu offers Closed from the gate, and no surface there withdraws a question.
    expect(transitions.awaiting_release).not.toContain('closed');
    expect(said).not.toMatch(/Closed|withdraw|Decisions panel|`awaiting_release`/);
    expect(said).not.toMatch(/\/api\/|voidQuestions|POST /);
  });

  it('says a failure reached no decision and is the operator’s to clear, not the person’s', () => {
    const refusal = closeRefusalOf(new Error('connection reset'));

    expect(refusal).toEqual({ kind: 'failed', message: 'connection reset' });
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: null,
      destination: 'awaiting_release',
    });
    expect(said).toContain('failed before it reached a decision: connection reset');
    expect(said).toContain('nothing here is yours to clear');
    expect(said).toContain('whoever operates this Forge');
    expect(said).toContain('Once that is fixed');
    expect(said).toContain('shipped with this batch');
    expect(said).not.toMatch(/Closed|the close can be made again/);
  });

  it('says so where a refusal names no blocking object', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
    });
    expect(said).toContain('The refusal named no blocking object.');
    expect(said).toContain('What clears it: mark the issue merged on its Properties rail');
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

describe('what a failed write says, never its statement or a bound value (ISS-1381 r2)', () => {
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

  it('keeps a short bound value out when the reason also quotes another one (ISS-1381 r2)', () => {
    const failed = new DrizzleQueryError(
      'update "issues" set "tenant" = $1 where "issues"."id" = $2',
      ['abc', 'bad'],
      Object.assign(new Error('tenant abc: invalid input syntax for type uuid: "bad"'), {
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

    for (const text of [said, closeFailureText(refusal)]) {
      expect(text).not.toContain('abc');
      expect(text).not.toContain('bad');
      expect(text).toContain('P0001');
      expect(text).toContain('a database function or trigger raised an error');
    }
  });

  it('keeps a one-character bound value out, standing alone or inside a word (ISS-1381 r2)', () => {
    const failed = new DrizzleQueryError(
      'update "issues" set "tenant" = $1 where "issues"."id" = $2',
      [7, 'bad'],
      Object.assign(new Error('tenant 7: invalid input syntax for type uuid: "bad"'), {
        code: 'P0001',
        severity: 'ERROR',
      }),
    );

    const embedded = new DrizzleQueryError(
      'update "issues" set "tenant" = $1 where "issues"."id" = $2',
      [7, 'bad'],
      Object.assign(new Error('tenant-7: invalid input syntax for type uuid: "bad"'), {
        code: 'P0001',
        severity: 'ERROR',
      }),
    );

    for (const text of [
      closeFailureText(closeRefusalOf(failed)),
      closeFailureText(closeRefusalOf(embedded)),
    ]) {
      expect(text).not.toMatch(/tenant.?7/);
      expect(text).toContain('a database function or trigger raised an error');
    }
  });

  it('names the SQLSTATE’s class where the query-error seal withheld the whole reason', () => {
    const failed = sealQueryError(
      new DrizzleQueryError(
        'update "issues" set "tenant" = $1 where "issues"."id" = $2',
        [7, 'bad'],
        Object.assign(new Error('tenant-7: invalid input syntax for type uuid: "bad"'), {
          code: 'P0001',
          severity: 'ERROR',
        }),
      ),
    );
    const refusal = closeRefusalOf(failed);
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
    });

    for (const text of [said, closeFailureText(refusal)]) {
      expect(text).toContain('a database function or trigger raised an error');
      expect(text).not.toMatch(/tenant.?7|"bad"/);
    }
  });

  it('says a database query failed without a reason when drizzle’s wrapper carries no driver error', () => {
    const failed = new DrizzleQueryError(
      'update "issues" set "status" = $1',
      ['closed'],
      new Error('x'),
    );
    (failed as { cause?: unknown }).cause = undefined;

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toBe('a database query failed without saying why');
  });
});

describe('a database reason a person reads, with the seal’s cuts put back where they took no value (ISS-1381 r3)', () => {
  const ISSUE = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const CLOSE_SQL =
    'update "issues" set "status" = $1 where ("issues"."id" = $2 and "issues"."status" = $3)';

  function sealedClose(message: string, fields: Record<string, unknown>) {
    return sealQueryError(
      new DrizzleQueryError(
        CLOSE_SQL,
        ['closed', ISSUE, 'releasing'],
        Object.assign(new Error(message), { severity: 'ERROR', ...fields }),
      ),
    );
  }

  it('names a rule whole beside the reason where the seal cut a bound value out of its name', () => {
    const failed = sealedClose(
      'new row for relation "issues" violates check constraint "gj_closed_needs_ledger"',
      { code: '23514', constraint_name: 'gj_closed_needs_ledger', table_name: 'issues' },
    );
    const refusal = closeRefusalOf(failed);
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
    });

    for (const text of [said, closeFailureText(refusal)]) {
      expect(text).toContain('(the database names constraint "gj_closed_needs_ledger")');
      expect(text).toContain('23514');
      for (const leaked of ['[Redacted]', ISSUE, 'releasing', 'update "issues"', 'Failed query']) {
        expect(text).not.toContain(leaked);
      }
    }
  });

  it('keeps a rule withheld whose whole name is a bound value', () => {
    const failed = sealedClose(
      'new row for relation "issues" violates check constraint "releasing"',
      {
        code: '23514',
        constraint_name: 'releasing',
        table_name: 'issues',
      },
    );

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toContain('23514');
    expect(text).not.toContain('releasing');
  });

  it.each([
    ['label "x_releasing_rule" is not allowed', 1],
    ['constraint "x_releasing_rule" rejected the write', 1],
    ['constraint "x_closed_rule" conflicts with constraint "x_releasing_rule"', 2],
  ])('rewrites no quote in the message as the name the error carries: %s', (message, cuts) => {
    const failed = sealedClose(message, { code: 'P0001', constraint_name: 'x_closed_rule' });

    const text = closeFailureText(closeRefusalOf(failed));
    const [inMessage, beside] = text.split(' (the database names ');

    expect(inMessage).not.toMatch(/x_closed_rule|x_releasing_rule/);
    expect(inMessage?.match(/"x_\(a value of this write, withheld\)_rule"/g)).toHaveLength(cuts);
    expect(beside).toBe('constraint "x_closed_rule")');
    expect(text).not.toContain('x_releasing_rule');
  });

  it('says in words, never as a marker, where a reason repeats a value of the write', () => {
    const failed = sealedClose('refund hook is still releasing funds', { code: 'P0001' });

    const text = closeFailureText(closeRefusalOf(failed));

    expect(text).toContain('refund hook is still (a value of this write, withheld) funds');
    expect(text).not.toContain('[Redacted]');
    expect(text).not.toContain('releasing');
  });
});

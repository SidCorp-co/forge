import { describe, expect, it } from 'vitest';
import { IssueDependencyError } from '../../issues/dependency-service.js';
import { TransitionError } from '../../issues/transition-error.js';
import { toolErrorText } from '../server.js';
import { leadWith, unwrittenRefusal } from './forge-issues-update-refusal.js';

const read = (err: unknown) => toolErrorText((err as Error).message);

describe('an update refusal that wrote nothing', () => {
  it('says the move was refused and nothing else written, before a long reason', () => {
    const why = `no work was found for this issue. ${'Read this. '.repeat(120)}`;
    const err = unwrittenRefusal(new TransitionError('NO_WORK_EVIDENCE', why), true);

    expect(err).toBeInstanceOf(TransitionError);
    expect(read(err)).toMatch(
      /^Error: NO_WORK_EVIDENCE: The status move was refused, so nothing else this update carried was written: send it again without `data\.status` to write the rest\. No work was found/,
    );
  });

  it('keeps the refusal code first and says nothing was written straight after it', () => {
    const err = unwrittenRefusal(new IssueDependencyError('SELF_DEP'), false);

    expect(read(err)).toMatch(
      /^Error: SELF_DEP: Nothing this update carried was written\. A relation names the issue itself/,
    );
  });

  it('names the status move among what was not written where the update sent one', () => {
    const err = unwrittenRefusal(new IssueDependencyError('CYCLE_DETECTED'), true);

    expect(read(err)).toMatch(
      /^Error: CYCLE_DETECTED: Nothing this update carried was written, the status move included\. /,
    );
  });

  it('keeps a not-found refusal classed as one', () => {
    const err = unwrittenRefusal(new IssueDependencyError('NOT_FOUND'), false);

    expect((err as Error).message).toMatch(/^NOT_FOUND: Nothing this update carried was written\./);
  });

  it('leaves a name the caller sends in its own case', () => {
    expect(leadWith('BAD_REQUEST: data.expect is a precondition', 'Nothing was written')).toBe(
      'BAD_REQUEST: Nothing was written. data.expect is a precondition',
    );
  });

  it('says only that nothing was written where the refusal said nothing more', () => {
    expect(leadWith('SELF_DEP', 'Nothing was written')).toBe('SELF_DEP: Nothing was written.');
  });
});

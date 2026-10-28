import { describe, expect, it } from 'vitest';
import { TransitionError } from '../issues/apply-transition.js';
import { transitions } from '../pipeline/state-machine.js';
import { reasonSentence, refusedCloseComment } from './refused-close-words.js';
import { closeRefusalOf } from './releasing-recovery.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

describe('what a finish says on an issue it could not close (ISS-1381)', () => {
  it('keeps every id a refusal names for a caller, and counts them in words for a person (ISS-1421)', () => {
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
      steps: [],
      outsideGit: false,
    });
    const said = refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
      delivered: true,
    });
    expect(said).toContain('The close was refused because the issue holds open questions.');
    expect(said).not.toMatch(/`|OPEN_QUESTIONS/);
    expect(said).toContain('Blocking it: 1 blocking run, 2 open questions.');
    expect(said).not.toMatch(/q-1|q-2|r-9/);
    expect(said).toContain('went out as version 1.4.0');
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
      delivered: true,
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
      delivered: true,
    });
    const [ours, ...quote] = said.split('\n\n> ');
    expect(ours).toContain('failed inside Forge before it reached a decision.');
    expect(ours).toContain('nothing here is yours to clear');
    expect(ours).toContain('whoever operates this Forge');
    expect(ours).toContain('went out with this batch');
    expect(ours).not.toMatch(/Closed|the close can be made again/);
    // ISS-1421 r41 (judge-167): the failure's own words are quoted beneath ours, never run into a
    // sentence of ours with a full stop of ours after them.
    expect(ours).not.toContain('connection reset');
    expect(quote).toEqual(['Connection reset.']);
  });

  it('says Release now fails the same way until a failed close is fixed (ISS-1381 r4)', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new Error('connection reset')),
      projectId: PROJECT,
      version: '1.4.0',
      destination: 'awaiting_release',
      delivered: true,
    });

    expect(said).toContain('Release now');
    expect(said).toContain('fails the same way until that failure is fixed');
    expect(said).not.toContain(
      'Once that is fixed, the release banner on this page offers Release now',
    );
  });

  it('names every earlier release a repeated failure came from, beside the one that shipped (ISS-1381 r4)', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new Error('connection reset')),
      projectId: PROJECT,
      version: '1.6.0',
      destination: 'awaiting_release',
      delivered: true,
      repeats: ['1.4.0', null],
    });

    expect(said).toContain('went out as version 1.6.0');
    expect(said).toContain('version 1.4.0');
    expect(said).toContain('one with no version');
    expect(said).toContain('for the same reason');
  });
});

describe('what a finish says it did, and what clears a missing mark (ISS-1421 r41)', () => {
  // ISS-1421 r41 (judge-167): "The refusal named no blocking object." is no sentence a person
  // understands, and Mark merged was named by a rail and not by its own steps.
  it('says nothing about what blocks a refusal that names nothing, and clears it by Mark merged', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
      delivered: true,
    });
    expect(said).not.toMatch(/blocking|Blocking/);
    expect(said).toContain(
      "What clears it: use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and name the commit that landed under Commit.",
    );
  });

  it('says Commit may stay empty where the project names no repository (criterion 393)', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
      delivered: true,
      noRepository: true,
    });
    expect(said).toContain(
      "What clears it: use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed; with no repository named, Commit may stay empty.",
    );
    expect(said).not.toContain('under Commit');
  });

  it('names where the work is, not a commit, for a lane outside git', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(
        new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it', { shape: 'outside_git' }),
      ),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
      delivered: true,
      noRepository: true,
    });
    expect(said).toContain(
      'name the live URL, CMS entry or storefront resource in Where it landed',
    );
    expect(said).not.toContain('Commit');
  });

  // ISS-1421 r41 (judge-167): the comment said "its code is live with that release" where the
  // release's own page said nothing was promoted, deployed or verified.
  it('says the code went out only where the release recorded a promotion or a deploy', () => {
    const refusal = closeRefusalOf(new TransitionError('OPEN_QUESTIONS', 'x', {}));
    const args = {
      refusal,
      projectId: PROJECT,
      version: '0.1.0',
      destination: 'awaiting_release' as const,
    };
    const quiet = refusedCloseComment({ ...args, delivered: false });
    expect(quiet).toContain(
      'The release finished as version 0.1.0, but this issue could not be closed.',
    );
    expect(quiet).toContain(
      'The issue is back at Awaiting release. That release recorded no promotion and no deploy, so nothing says its code is live.',
    );
    expect(quiet).not.toMatch(/went out|is live with/);
    const done = refusedCloseComment({ ...args, delivered: true });
    expect(done).toContain('The release finished and went out as version 0.1.0');
    expect(done).toContain(
      'The issue is back at Awaiting release, and its code went out with that release.',
    );
  });

  it('gives a promoted roster its settlement in place of the gate, and claims no move', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'releasing',
      delivered: true,
      held: 'This batch recorded a promotion; abort it to settle.',
    });
    expect(said).toContain('This batch recorded a promotion; abort it to settle.');
    expect(said).toContain('Clear the reason above first');
    expect(said).not.toContain('The issue is at');
  });
});

// ISS-1421 r40 (judge-164): an abort's comment opened "batch release aborted: …", and a reason that
// already ended in a full stop was followed by another.
describe('a hand-back reason as the opening sentence of its comment', () => {
  it.each([
    [
      'another batch was already in flight, so this one never started',
      'Another batch was already in flight, so this one never started.',
    ],
    [
      'The release run failed, so nothing is carrying this issue to production.',
      'The release run failed, so nothing is carrying this issue to production.',
    ],
    [
      'The release was aborted: a person stopped it. ',
      'The release was aborted: a person stopped it.',
    ],
    // ISS-1421 r41 (judge-167): a reason ending on its own mark read "Stop!.".
    ['The release was aborted: Stop!', 'The release was aborted: Stop!'],
    ['did it deploy? ', 'Did it deploy?'],
    ['The release was aborted: Stop!.', 'The release was aborted: Stop!'],
  ])('says %j as %j', (reason, said) => {
    expect(reasonSentence(reason)).toBe(said);
  });
});

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
      delivery: 'reported',
      marked: true,
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
      delivery: 'reported',
      marked: true,
    });

    expect(said).toContain(
      'What clears it: answer the open question in its "Decision waiting" card',
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
      delivery: 'reported',
      marked: true,
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
      delivery: 'reported',
      marked: true,
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
      delivery: 'reported',
      marked: true,
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
      delivery: 'reported',
      marked: true,
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
      delivery: 'reported',
      marked: true,
      commit: 'claim',
    });
    expect(said).toContain(
      "What clears it: use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed; with no repository named, Commit may stay empty.",
    );
    expect(said).not.toContain('under Commit');
  });

  // ISS-1421 r43 (judge-171 on 407): a commit named on a repository Forge cannot read is refused,
  // so the comment says what Mark merged's panel there says.
  it('says to leave Commit empty for a claim where Forge cannot read the named repository', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged')),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
      delivery: 'reported',
      marked: false,
      commit: 'refused',
    });
    expect(said).toContain(
      "What clears it: use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and leave Commit empty to record a claim naming no commit. Forge cannot read this project's repository, so a commit named under Commit is refused;",
    );
    expect(said).not.toContain('name the commit that landed');
  });

  // ISS-1421 r43 (brief item 4): Forge writes the finish's comment and names who reported it, in a
  // sentence of its own after the opening, so a lower-case name never opens the comment.
  it('names who reported the finish after the opening sentence', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(new TransitionError('OPEN_QUESTIONS', 'x', {})),
      projectId: PROJECT,
      version: '0.2.0',
      destination: 'awaiting_release',
      delivery: 'unreported',
      marked: true,
      finishedBy: 'lan nguyen',
    });
    expect(said).toMatch(
      /^The release finished as version 0\.2\.0, but this issue could not be closed\. The finish was reported by lan nguyen\. The close was refused/,
    );
  });

  it('names where the work is, not a commit, for a lane outside git', () => {
    const said = refusedCloseComment({
      refusal: closeRefusalOf(
        new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it', { shape: 'outside_git' }),
      ),
      projectId: PROJECT,
      version: '2.0.0',
      destination: 'awaiting_release',
      delivery: 'reported',
      marked: true,
      commit: 'claim',
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
    const quiet = refusedCloseComment({ ...args, delivery: 'none', marked: true });
    expect(quiet).toContain(
      'The release finished as version 0.1.0, but this issue could not be closed.',
    );
    expect(quiet).toContain(
      'The issue is back at Awaiting release. That release recorded no promotion and no deploy, so nothing says its code is live.',
    );
    expect(quiet).not.toMatch(/went out|is live with/);
    const done = refusedCloseComment({ ...args, delivery: 'reported', marked: true });
    expect(done).toContain('The release finished and went out as version 0.1.0');
    expect(done).toContain(
      'The issue is back at Awaiting release, and its code went out with that release.',
    );
  });
});

// ISS-1421 r42 (judge-169, criterion 398): an issue refused for its missing mark was told "its code
// went out with that release" beside its own reason that nothing says its work was on that branch.
// The claim needs both halves: a delivery that reported going out, and a mark saying where it landed.
describe('whether a finish says the issue’s code went out', () => {
  const unmarkedRefusal = closeRefusalOf(
    new TransitionError('CLOSE_REQUIRES_SHIPPED', 'mark it merged', { to: 'closed' }),
  );
  const questionRefusal = closeRefusalOf(
    new TransitionError('OPEN_QUESTIONS', 'answer it', { openQuestionIds: ['q-1'] }),
  );
  const failedRefusal = closeRefusalOf(new Error('connection reset'));
  const said = (
    refusal: ReturnType<typeof closeRefusalOf>,
    delivery: 'reported' | 'unreported' | 'none',
    marked: boolean,
  ) =>
    refusedCloseComment({
      refusal,
      projectId: PROJECT,
      version: '0.8.0',
      destination: 'awaiting_release',
      delivery,
      marked,
    });
  const WENT_OUT = 'and its code went out with that release.';

  it('says it only for a marked issue whose release reported going out', () => {
    for (const refusal of [questionRefusal, failedRefusal]) {
      const both = said(refusal, 'reported', true);
      expect(both).toContain('The release finished and went out as version 0.8.0');
      expect(both).toContain(`The issue is back at Awaiting release, ${WENT_OUT}`);
    }
  });

  it('says an unmarked issue’s code is not known to have gone out, though the release did', () => {
    for (const refusal of [unmarkedRefusal, questionRefusal, failedRefusal]) {
      const text = said(refusal, 'reported', false);
      expect(text).toContain('The release finished and went out as version 0.8.0');
      expect(text).toContain(
        'The issue is back at Awaiting release. It is not marked merged, so nothing says its code went out with that release.',
      );
      expect(text).not.toContain(WENT_OUT);
    }
  });

  it('says a mark that names no landing is no proof the code went out', () => {
    const text = said(unmarkedRefusal, 'reported', true);
    expect(text).toContain(
      'Its mark does not say where its work landed, so nothing says its code went out with that release.',
    );
    expect(text).not.toContain(WENT_OUT);
  });

  it('never says the release went out where no promotion or deploy reported going out', () => {
    for (const marked of [true, false]) {
      for (const refusal of [unmarkedRefusal, questionRefusal, failedRefusal]) {
        const declared = said(refusal, 'unreported', marked);
        expect(declared).toContain('The release finished as version 0.8.0, but');
        expect(declared).toContain(
          'No promotion or deploy of that release reported going out, so nothing says its code is live.',
        );
        expect(declared).not.toMatch(/went out (as|with)|code went out/);
        const none = said(refusal, 'none', marked);
        expect(none).toContain(
          'That release recorded no promotion and no deploy, so nothing says its code is live.',
        );
        expect(none).not.toMatch(/went out (as|with)|code went out/);
      }
    }
  });
});

// ISS-1421 r42 (judge-169): one question read "holds open questions" and "answer each open question".
describe('a close refused for open questions, counted', () => {
  const comment = (ids: string[]) =>
    refusedCloseComment({
      refusal: closeRefusalOf(
        new TransitionError('OPEN_QUESTIONS', 'answer them', { openQuestionIds: ids }),
      ),
      projectId: PROJECT,
      version: '0.9.0',
      destination: 'awaiting_release',
      delivery: 'reported',
      marked: true,
    });

  it('speaks of one question as one', () => {
    const one = comment(['q-1']);
    expect(one).toContain('The close was refused because the issue holds an open question.');
    expect(one).toContain(
      'What clears it: answer the open question in its "Decision waiting" card',
    );
    expect(one).not.toMatch(/open questions|each open question/);
  });

  it('speaks of two as several', () => {
    const two = comment(['q-1', 'q-2']);
    expect(two).toContain('The close was refused because the issue holds open questions.');
    expect(two).toContain('answer each open question');
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
    // ISS-1421 r42 (judge-169): "Hold on..." read "Hold on.": an ellipsis is the writer's own mark.
    ['Ada aborted the release: Hold on...', 'Ada aborted the release: Hold on...'],
    ['wait for the hotfix… ', 'Wait for the hotfix…'],
  ])('says %j as %j', (reason, said) => {
    expect(reasonSentence(reason)).toBe(said);
  });
});

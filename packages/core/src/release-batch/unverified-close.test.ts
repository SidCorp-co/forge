import { describe, expect, it } from 'vitest';
import { unverifiedCloseNote, unverifiedMarker } from './unverified-close.js';

const RUN = '11111111-1111-4111-8111-111111111111';

// ISS-1322, routed from ISS-1321's judge: every issue an unverified release closes reads this, and
// the projects that release unverified are the ones whose deployment cannot report a commit.
describe('the note on an issue an unverified release closes', () => {
  it('names the commit the release reported', () => {
    const note = unverifiedCloseNote(RUN, 'abc1234');
    expect(note).toContain('not verified');
    expect(note).toContain('`abc1234`');
    expect(note).toContain(unverifiedMarker(RUN));
  });

  it('says the release reported no commit, rather than citing an account it never gave', () => {
    const note = unverifiedCloseNote(RUN, null);
    expect(note).toMatch(/reported no commit/i);
    expect(note).not.toMatch(/own account/i);
    expect(note).toContain(unverifiedMarker(RUN));
  });

  it('gives an act open to a project with no probe: look at the live deployment, and reopen', () => {
    for (const commit of ['abc1234', null]) {
      const note = unverifiedCloseNote(RUN, commit);
      expect(note).toMatch(/live deployment/i);
      expect(note).toMatch(/reopen this issue/i);
    }
  });

  it('offers a commit endpoint only to a deployment that can report one, never as the act', () => {
    const note = unverifiedCloseNote(RUN, null);
    expect(note).not.toMatch(/^Declare /m);
    expect(note).not.toMatch(/\. Declare /);
    expect(note).toMatch(/if (your|the) live deployment can report/i);
  });
});

// ISS-1282 — a project with two live bindings may declare a probe on one and none on the other, so a
// close can be verified at some of its deploy bindings and not at the rest.
describe('the note on an issue a release closed with some bindings unread', () => {
  const unread = ['coolify [eu] b-2'];

  it('names the binding nothing read, and says the others were', () => {
    const note = unverifiedCloseNote(RUN, 'abc1234', unread);

    expect(note).toContain('verified at only some of its deploy bindings');
    expect(note).toContain('coolify [eu] b-2');
    expect(note).toContain('The bindings that do declare one were read and confirmed');
    expect(note).toContain(unverifiedMarker(RUN));
  });

  it('does not say the whole project declares no probe, which is false of the ones read', () => {
    const note = unverifiedCloseNote(RUN, null, unread);

    expect(note).not.toContain('This project declares no verify probe');
    expect(note).not.toContain('closed by a release that was not verified');
  });

  it('lists every unread binding', () => {
    const note = unverifiedCloseNote(RUN, null, ['coolify [eu] b-2', 'coolify [asia] b-3']);

    expect(note).toContain('coolify [eu] b-2, coolify [asia] b-3');
  });

  it('keeps the whole-release wording where nothing is named as unread', () => {
    expect(unverifiedCloseNote(RUN, null, [])).toContain('This project declares no verify probe');
    expect(unverifiedCloseNote(RUN, null)).toContain('closed by a release that was not verified');
  });
});

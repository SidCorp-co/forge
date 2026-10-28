/**
 * ISS-1421 — a sentence a person reads says how a release run ended in words, never as the stored
 * run status it reads: "ended failed" and "ended cancelled" are not English.
 */

import { describe, expect, it } from 'vitest';
import { releaseRunStopped } from './run-ended-words.js';

describe('releaseRunStopped (ISS-1421)', () => {
  it.each([
    ['failed', 'The release run failed without finishing its release'],
    ['cancelled', 'The release run was cancelled without finishing its release'],
  ])('says a run that ended %s in words', (status, said) => {
    expect(releaseRunStopped(status)).toBe(said);
  });

  // ISS-1421 r43 (judge-171): "The release run completed without finishing its release" stood
  // under the finish's own "The release finished": a release run completes only by finishing.
  it('says a run that completed finished its release, never that it ended without finishing', () => {
    expect(releaseRunStopped('completed')).toBe(
      'The release finished but left this issue at Releasing',
    );
    expect(releaseRunStopped('completed')).not.toMatch(/without finishing/);
  });

  it('says a status it has no word for as stopped, never as the stored value', () => {
    expect(releaseRunStopped('paused')).toBe(
      'The release run stopped without finishing its release',
    );
    expect(releaseRunStopped(null)).toBe('The release run stopped without finishing its release');
  });
});

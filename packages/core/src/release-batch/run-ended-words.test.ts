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
    ['completed', 'The release run completed without finishing its release'],
  ])('says a run that ended %s in words', (status, said) => {
    expect(releaseRunStopped(status)).toBe(said);
  });

  it('names the run where it is given', () => {
    expect(releaseRunStopped('failed', 'run-7')).toBe(
      'Release run run-7 failed without finishing its release',
    );
  });

  it('says a status it has no word for as stopped, never as the stored value', () => {
    expect(releaseRunStopped('paused')).toBe(
      'The release run stopped without finishing its release',
    );
    expect(releaseRunStopped(null)).toBe('The release run stopped without finishing its release');
  });
});

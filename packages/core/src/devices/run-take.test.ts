/**
 * Which issues a declared run takes, by its role: a judge (`qa`, `reviewer`) carries an issue that is
 * over untaken beside the work it takes, a build takes every issue it names (and is refused the one
 * that is over at the take), and a run naming no role keeps the ISS-576 reading.
 */

import { describe, expect, it } from 'vitest';
import { takenBy } from './run-take.js';

const group = { keys: ['ISS-1', 'ISS-2', 'ISS-3'], seqs: [1, 2, 3] };
const statuses = { 'ISS-1': 'closed', 'ISS-2': 'awaiting_release', 'ISS-3': 'dropped' };

describe('the issues a declared run takes', () => {
  it.each(['qa', 'forge:qa', 'reviewer', 'forge:reviewer'])(
    'a %s run carries the closed and dropped issues untaken and takes the rest',
    (role) => {
      expect(takenBy(group, statuses, role)).toEqual({ keys: ['ISS-2'], seqs: [2] });
    },
  );

  it.each(['runner', 'forge:runner'])(
    'a %s run takes every issue it names, the closed one included, for the take to refuse',
    (role) => {
      expect(takenBy(group, statuses, role)).toEqual(group);
    },
  );

  it('a run naming no role over issues all over takes nothing (ISS-576)', () => {
    const over = { keys: ['ISS-1', 'ISS-3'], seqs: [1, 3] };
    expect(takenBy(over, statuses, undefined)).toEqual({ keys: [], seqs: [] });
  });
});

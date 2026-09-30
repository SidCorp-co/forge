import { describe, expect, it } from 'vitest';
import { nextForCheck } from './land.mjs';

const next = (state) => nextForCheck(state, 'chore/verify-window-w1', 'main');

describe('nextForCheck', () => {
  it('reads an absent check as nothing refused yet, and names where it will run', () => {
    expect(next('absent')).toBe(
      "nothing has reported there yet, so nothing has refused: the check runs on the window's one pull request from chore/verify-window-w1 into main, and is read again once that run concludes",
    );
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'reads %s as a run still in flight',
    (state) => {
      expect(next(state)).toBe('its run has not concluded: read it again once it has');
    },
  );

  it.each(['failure', 'timed_out'])('sends %s to attribution', (state) => {
    expect(next(state)).toBe('attribute the refusal before anything lands');
  });

  it.each(['cancelled', 'neutral', 'skipped', 'stale', 'action_required'])(
    'reads %s as no verdict, attributing nothing',
    (state) => {
      expect(next(state)).toBe(
        'that conclusion is no verdict on the tree, so nothing is attributed: re-run the check',
      );
    },
  );
});

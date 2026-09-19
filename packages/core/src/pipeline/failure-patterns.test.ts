import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-classifier.js';
import { causeForText } from './failure-patterns.js';

describe('a pane whose prompt was never submitted (ISS-1101, pairing with ISS-1096)', () => {
  const NEVER_STARTED =
    "the job's pane `forge-job-3d93cbab` was opened and its prompt delivered, but the agent " +
    'never reported submitting it, or anything else, in 120s — tmux accepted the keystroke and ' +
    'no turn ever began, so this box never had work in flight to report';

  it("classifies the box's never-started sentence rather than leaving it unclassified", () => {
    expect(classifyFailure({ error: NEVER_STARTED }).cause).toBe('turn_never_reported');
  });

  it('does not fire on half the sentence', () => {
    expect(causeForText('the agent never reported submitting anything')).not.toBe(
      'turn_never_reported',
    );
  });

  it('is not read as a runner that never took the dispatch', () => {
    expect(causeForText(NEVER_STARTED)).not.toBe('runner_unreachable');
  });
});

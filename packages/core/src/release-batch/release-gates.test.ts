import { describe, expect, it } from 'vitest';
import { blocker } from './blocker-kit.js';
import { NO_RELEASE_GATE_HOLD } from './hold.js';
import { gateViews } from './release-gates.js';

// PR #1055 review: catalog-api 0.1.0's banner read "Waiting on you: declare a production environment"
// while its gate, on the same page, read "No release step. This project ships on close; there is no
// release to cut." An issue at the release gate closes only through a release
// (`transition-guards.ts:releaseGuard`), so the gate's own words said what the kernel refuses.

describe('a project with no production environment, said by its gate', () => {
  const [gate] = gateViews([blocker('NO_RELEASE_GATE')], [], ['orchestrator']);

  it('names what is missing, in the words the banner and the rail use', () => {
    expect(gate?.title).toBe('No production environment');
    expect(gate?.sentence).toBe('A release has nowhere to go until one is declared.');
    expect(gate?.owner.act).toBe('declare a production environment');
  });

  it('never says closing an issue ships it: only a release closes one at the gate', () => {
    for (const said of [
      gate?.title,
      gate?.sentence,
      gate?.detail,
      NO_RELEASE_GATE_HOLD.reason,
      NO_RELEASE_GATE_HOLD.waitingFor,
    ]) {
      expect(said).not.toMatch(
        /ships on close|closing an issue is what ships|or close the issue|no release step/i,
      );
    }
  });
});

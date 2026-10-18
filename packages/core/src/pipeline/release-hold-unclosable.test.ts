import { describe, expect, it } from 'vitest';
import { closeRefusedHold } from './release-hold.js';

// ISS-1421 r6 — judge-37 read "holds 1 open question (`OPEN_QUESTIONS`)" mid-paragraph on a held
// issue. The hold names each shortfall in the banner's own sentence and never its code (criterion 90).
describe('the hold the automatic release leaves on an issue whose close would be refused', () => {
  it('names each shortfall as the banner does, with no code in brackets or backticks', () => {
    const hold = closeRefusedHold([
      {
        code: 'OPEN_QUESTIONS',
        reason: 'holds 1 open question',
        clears: 'Answer it in its "Decision waiting" card on the issue\'s page.',
        clearsHere: 'Answer it in the Decision waiting card above.',
      },
      {
        code: 'CLOSE_REQUIRES_SHIPPED',
        reason: 'not marked merged',
        clears:
          "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed.",
        clearsHere:
          "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed.",
      },
    ]);
    expect(hold.code).toBe('RELEASE_ISSUES_UNCLOSABLE');
    // What holds it in one sentence, each shortfall's step after it, then what follows (r8).
    expect(hold.reason).toContain(
      'because it holds 1 open question, it is not marked merged and its close would be refused. Answer it in the Decision waiting card above. Use Mark merged',
    );
    expect(hold.reason).toMatch(/The next sweep releases it once that is done\.$/);
    expect(hold.reason).not.toMatch(/OPEN_QUESTIONS|CLOSE_REQUIRES_SHIPPED|`|\(/);
    expect(hold.owes).toBe('human');
  });
});

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
    expect(hold.reason).toContain(
      'It holds 1 open question. Answer it in the Decision waiting card above.',
    );
    expect(hold.reason).toContain('It is not marked merged. Use Mark merged');
    expect(hold.reason).not.toMatch(/OPEN_QUESTIONS|CLOSE_REQUIRES_SHIPPED|`|\(/);
    expect(hold.owes).toBe('human');
  });
});

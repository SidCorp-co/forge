import { describe, expect, it } from 'vitest';
import { closeRefusedHold, refusalHold, releaseHoldComment } from './release-hold.js';

// The words a hold's comment is written in, as a person reads them on the issue (ISS-1421 r8).
describe('the comment a hold is written in', () => {
  // ISS-1421 r8, criterion 90: judge-40 read `releaseHold` and `release-hold: CODE` as code spans.
  it('words an unclosable hold with no code in brackets or backticks, shared or not', () => {
    const hold = closeRefusedHold([
      {
        code: 'OPEN_QUESTIONS',
        reason: 'holds 1 open question',
        clears: 'Answer it on the issue.',
        clearsHere: 'Answer it in the Decision waiting card above.',
      },
    ]);
    for (const body of [
      releaseHoldComment(hold),
      releaseHoldComment(hold, true, ['ISS-5', 'ISS-3']),
    ]) {
      expect(body).toContain('Answer it in the Decision waiting card above.');
      expect(body).not.toMatch(/`|\(|RELEASE_ISSUES_UNCLOSABLE|OPEN_QUESTIONS|releaseHold/);
    }
  });

  // ISS-1346 judge r2 finding 2: a comment standing for several rows named none of them.
  it('names each row a shared hold stands for, in the order it was given them', () => {
    const hold = refusalHold('NO_RUNNER_ONLINE', ['none online']);
    const body = releaseHoldComment(hold, true, ['ISS-5', 'ISS-3', 'ISS-4']);
    expect(body).toContain('This one comment stands for ISS-5, ISS-3, ISS-4, oldest merge first.');
    // A hold standing for one row alone, or not shared, names no other row.
    expect(releaseHoldComment(hold, true, ['ISS-5'])).not.toContain('stands for');
    expect(releaseHoldComment(hold, false, ['ISS-5', 'ISS-3'])).not.toContain('stands for');
  });

  // ISS-1421 r8, criterion 90: the master read five sentences, two of them hard to read.
  it('words an unclosable hold as what holds it, what to do and what follows, three sentences', () => {
    const hold = closeRefusedHold([
      {
        code: 'OPEN_QUESTIONS',
        reason: 'holds 1 open question',
        clears: 'Answer it on the issue.',
        clearsHere: 'Answer it in the Decision waiting card above.',
      },
    ]);
    const body = releaseHoldComment(hold, true, ['ISS-8']);
    expect(body).toBe(
      '**Held by the automatic release**\n\n' +
        'The automatic release leaves this issue out, because it holds 1 open question and its close would be refused. ' +
        'Answer it in the Decision waiting card above. The next sweep releases it once that is done.',
    );
    const sentences = body.split('\n\n')[1]?.split(/(?<=\.)\s+/) ?? [];
    expect(sentences).toHaveLength(3);
    for (const s of sentences) expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(20);
  });
});

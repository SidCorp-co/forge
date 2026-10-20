import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { openQuestionsFault } from '../questions/issue-coupling.js';
import { describeRewrite, noOpSentence } from './close-substitution.js';
import { refuseUnshippedClose } from './merged-at.js';
import { parkQuestionNotMinted } from './park-question.js';
import { parkReasonFault } from './transition-reason.js';

// ISS-1421 r13 — judge-58 still read the old register on two status-menu refusals: "issue already in
// status Draft (draft)" and "a transition to On hold (on_hold) must carry a reason …". Every refusal
// a status move answers names a status by its label alone, in capitalised sentences ending with a
// full stop; the values a caller sends back stay in the refusal's details.

const VALUE_IN_BRACKETS = new RegExp(`\\((${issueStatuses.join('|')})\\)`);

function inWords(message: string, maxWords = 40): void {
  expect(message, message).not.toMatch(VALUE_IN_BRACKETS);
  for (const sentence of message.split(/(?<=\.)\s+(?=[A-Z`])/)) {
    expect(sentence, sentence).toMatch(/^[A-Z`]/);
    expect(sentence, sentence).toMatch(/[.)]$/);
    expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(maxWords);
  }
}

describe('a move to the status the issue is already at', () => {
  it('says so in a plain sentence, as the status menu shows it', () => {
    const said = noOpSentence({
      projectId: 'p',
      requested: 'draft',
      parked: 'draft',
      final: 'draft',
    });
    expect(said).toBe('The issue is already at Draft.');
    inWords(said, 25);
  });

  it.each(issueStatuses)('names %s by its label alone', (status) => {
    inWords(noOpSentence({ projectId: 'p', requested: status, parked: status, final: status }));
  });

  it('names both statuses by label where a rule stored another', () => {
    inWords(
      noOpSentence({
        projectId: 'p',
        requested: 'closed',
        parked: 'closed',
        final: 'awaiting_release',
      }),
      60,
    );
    const rewrite = describeRewrite({
      requested: 'needs_info',
      parked: 'waiting',
      final: 'waiting',
      sentKind: null,
      storedKind: null,
    });
    expect(rewrite?.detail).toMatch(/^Needs info was stored as Waiting /);
    expect(rewrite?.requested).toBe('needs_info');
    expect(rewrite?.stored).toBe('waiting');
  });
});

describe('a park with no reason', () => {
  it('asks for the reason On hold needs in plain sentences', () => {
    const fault = parkReasonFault('in_progress', 'on_hold', {});
    expect(fault?.code).toBe('TRANSITION_REASON_REQUIRED');
    expect(fault?.detail).toBe(
      'A move to On hold needs a reason saying why the work is being paused. Send it as `reason`, or as `data.reason` or `data.note` on `forge_issues`.',
    );
    inWords(fault?.detail ?? '', 25);
  });

  it.each(['needs_info', 'waiting', 'reopen'] as const)('words the %s ask the same way', (to) => {
    const fault = parkReasonFault('developed', to, {});
    expect(fault).not.toBeNull();
    inWords(fault?.detail ?? '', 25);
  });

  it('asks a Waiting park for its kind in a sentence', () => {
    const fault = parkReasonFault('in_progress', 'waiting', { transitionReason: 'a key' });
    expect(fault?.detail).toBe(
      'A Waiting park must say which kind it is: `needs_decision` or `needs_resource`.',
    );
  });
});

describe('the other refusals a status move meets', () => {
  it('a close with no merge names Mark merged and Dropped in sentences of at most 20 words', async () => {
    const executor = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [
                { mergedAt: null, mergedCommitSha: null, mergedLanding: null, kind: 'standard' },
              ],
            }),
          }),
        }),
      }),
    };
    const refusal = await refuseUnshippedClose(executor as never, {
      issueId: 'i',
      toStatus: 'closed',
    });
    expect(refusal?.detail).toMatch(/Mark merged/);
    expect(refusal?.detail).toMatch(/Dropped/);
    expect(refusal?.detail).not.toMatch(/merged_at/);
    inWords(refusal?.detail ?? '', 20);
  });

  it('a terminal move over an open question names its status by label', () => {
    const fault = openQuestionsFault(['q1'], 'dropped');
    expect(fault.detail).toMatch(/^This issue holds 1 open question \(q1\), and Dropped would/);
    expect(fault.details).toEqual({ to: 'dropped', openQuestionIds: ['q1'] });
    inWords(fault.detail, 60);
  });

  it('a park that asks no question names the statuses that do by label', () => {
    const said = parkQuestionNotMinted({
      issue: { id: 'i', projectId: 'p' },
      toStatus: 'on_hold',
      actor: { type: 'device', id: 'd', ownerId: 'u', agency: 'agent' } as never,
      options: { needs: 'a key' },
    });
    expect(said).not.toBeNull();
    inWords(said ?? '', 30);
  });
});

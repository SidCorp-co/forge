/**
 * ISS-696 (REQ-67 BC-6): a stall the writer cannot place is refused by name, never guessed; one it
 * can is placed on its cause's item, issue and question.
 *
 * @direct-test-of packages/core/src/issues/stalls.ts
 */

import { describe, expect, it } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { placeStall } from './stalls.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const issueId = '00000000-0000-4000-8000-000000000002';
const requirementId = '00000000-0000-4000-8000-000000000003';

function refusedAs(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isRefusal(err) ? (err.refusals[0]?.code ?? null) : 'not a refusal';
  }
}

describe('placeStall', () => {
  it('places an unclear-item stall on its requirement with the question it raised', () => {
    const row = placeStall({
      projectId,
      cause: 'unclear_item',
      requirementId,
      issueId,
      question: { id: '00000000-0000-4000-8000-000000000004', text: 'Which unit?' },
    });
    expect(row).toMatchObject({
      cause: 'unclear_item',
      requirementId,
      feedbackId: null,
      issueId,
      question: 'Which unit?',
    });
  });

  it('places a defect and a waiting stall on their issue', () => {
    expect(placeStall({ projectId, cause: 'defect', issueId }).issueId).toBe(issueId);
    expect(placeStall({ projectId, cause: 'waiting_on_person', issueId }).question).toBeNull();
  });

  it('refuses an unclear item that names no item', () => {
    expect(refusedAs(() => placeStall({ projectId, cause: 'unclear_item', issueId }))).toBe(
      'STALL_ITEM_MISSING',
    );
  });

  it('refuses a defect or a wait that names no issue', () => {
    expect(refusedAs(() => placeStall({ projectId, cause: 'defect', requirementId }))).toBe(
      'STALL_ISSUE_MISSING',
    );
    expect(refusedAs(() => placeStall({ projectId, cause: 'waiting_on_person' }))).toBe(
      'STALL_ISSUE_MISSING',
    );
  });

  it("keeps a defect reopen's evidence, and refuses evidence on any other cause (ISS-927)", () => {
    const evidence = { liveRead: 'the total cell is empty' };
    expect(placeStall({ projectId, cause: 'defect', issueId, evidence }).evidence).toEqual(
      evidence,
    );
    expect(placeStall({ projectId, cause: 'defect', issueId }).evidence).toBeNull();
    expect(
      refusedAs(() => placeStall({ projectId, cause: 'waiting_on_person', issueId, evidence })),
    ).toBe('STALL_EVIDENCE_NOT_DEFECT');
  });

  it('refuses a cause outside the vocabulary', () => {
    expect(refusedAs(() => placeStall({ projectId, cause: 'slow' as never, issueId }))).toBe(
      'STALL_CAUSE_UNKNOWN',
    );
  });
});

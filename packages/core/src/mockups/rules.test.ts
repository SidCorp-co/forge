import { MOCKUP_LIMITS, type ProposeMockupRequest } from '@forge/contracts/mockups';
import { describe, expect, it } from 'vitest';
import {
  contentRefusal,
  decidedRefusal,
  deciderRefusal,
  queueRefusal,
  returnReasonRefusal,
  revisionRefusal,
  sizeRefusal,
  sourceProjectRefusal,
  typeRefusal,
  withdrawRefusal,
} from './rules.js';

const body = (over: Partial<ProposeMockupRequest> = {}): ProposeMockupRequest => ({
  target: { issue: 'ISS-1' },
  kind: 'image',
  name: 'a.png',
  contentBase64: 'iVBORw0KGgo=',
  ...over,
});

describe('mockup rules (ISS-78)', () => {
  it('takes exactly one of bytes, a document or a source (MOCKUP_CONTENT_REQUIRED)', () => {
    expect(contentRefusal(body())).toBeNull();
    expect(contentRefusal(body({ contentBase64: undefined }))?.code).toBe(
      'MOCKUP_CONTENT_REQUIRED',
    );
    expect(
      contentRefusal(body({ source: { from: 'issue', attachmentId: crypto.randomUUID() } }))?.code,
    ).toBe('MOCKUP_CONTENT_REQUIRED');
    expect(
      contentRefusal(body({ contentBase64: undefined, kind: 'image', document: { shapes: [] } }))
        ?.path,
    ).toBe('/document');
  });

  it('refuses a type its kind does not take, naming the types it does (MOCKUP_TYPE_INVALID)', () => {
    expect(typeRefusal('image', 'image/png')).toBeNull();
    const wrong = typeRefusal('image', 'text/html');
    expect(wrong?.code).toBe('MOCKUP_TYPE_INVALID');
    expect(wrong?.detail).toContain('image/png');
    expect(typeRefusal('sketch', 'image/jpeg')?.code).toBe('MOCKUP_TYPE_INVALID');
  });

  it('refuses a mockup over its kind’s size (MOCKUP_TOO_LARGE), and an empty one', () => {
    expect(sizeRefusal('api_example', MOCKUP_LIMITS.bytes.api_example)).toBeNull();
    expect(sizeRefusal('api_example', MOCKUP_LIMITS.bytes.api_example + 1)?.code).toBe(
      'MOCKUP_TOO_LARGE',
    );
    expect(sizeRefusal('image', 0)?.code).toBe('MOCKUP_TYPE_INVALID');
  });

  it("refuses another project's upload by name, and a missing one (MOCKUP_SOURCE_OTHER_PROJECT)", () => {
    expect(sourceProjectRefusal('issue', 'a1', 'p1', 'p1')).toBeNull();
    expect(sourceProjectRefusal('issue', 'a1', 'p2', 'p1')?.code).toBe(
      'MOCKUP_SOURCE_OTHER_PROJECT',
    );
    expect(sourceProjectRefusal('issue', 'a1', null, 'p1')?.code).toBe('MOCKUP_SOURCE_NOT_FOUND');
  });

  it('refuses a superseded revision and names the head (MOCKUP_REVISION_SUPERSEDED)', () => {
    expect(revisionRefusal('REQ-4', 2, 'current', 2)).toBeNull();
    expect(revisionRefusal('REQ-4', 3, 'draft', 2)).toBeNull();
    const old = revisionRefusal('REQ-4', 1, 'superseded', 2);
    expect(old?.code).toBe('MOCKUP_REVISION_SUPERSEDED');
    expect(old?.detail).toContain('revision 2');
    expect(revisionRefusal('REQ-4', 9, null, 2)?.code).toBe('MOCKUP_TARGET_INVALID');
  });

  it('holds at most the open queue a target keeps (MOCKUP_QUEUE_FULL)', () => {
    expect(queueRefusal('ISS-1', MOCKUP_LIMITS.openPerTarget - 1)).toBeNull();
    expect(queueRefusal('ISS-1', MOCKUP_LIMITS.openPerTarget)?.code).toBe('MOCKUP_QUEUE_FULL');
  });

  it('decides only a proposed mockup (MOCKUP_DECIDED)', () => {
    expect(decidedRefusal('MK-1', 'proposed')).toBeNull();
    expect(decidedRefusal('MK-1', 'accepted')?.code).toBe('MOCKUP_DECIDED');
  });

  it('leaves accept and return to a holder of mockups.approve, an agent and the author included (ADR 0007)', () => {
    const agentAdmin = { userId: 'agent-1', role: 'admin' as const };
    expect(deciderRefusal(agentAdmin, 'p1', 'MK-1', 'accept')).toBeNull();
    expect(deciderRefusal(agentAdmin, 'p1', 'MK-1', 'return')).toBeNull();
    const member = deciderRefusal({ userId: 'agent-2', role: 'member' }, 'p1', 'MK-1', 'accept');
    expect(member).toMatchObject({
      code: 'APPROVE_PERMISSION_REQUIRED',
      permission: 'mockups.approve',
      resource: 'mockups',
    });
    expect(deciderRefusal({ userId: 'u3', role: null }, 'p1', 'MK-1', 'return')?.code).toBe(
      'APPROVE_PERMISSION_REQUIRED',
    );
  });

  it('returns with a reason (MOCKUP_REASON_REQUIRED), and only its author withdraws', () => {
    expect(returnReasonRefusal('too dense')).toBeNull();
    expect(returnReasonRefusal('  ')?.code).toBe('MOCKUP_REASON_REQUIRED');
    expect(withdrawRefusal('MK-1', 'u1', 'u1')).toBeNull();
    expect(withdrawRefusal('MK-1', 'u2', 'u1')?.code).toBe('MOCKUP_WITHDRAW_FORBIDDEN');
  });
});

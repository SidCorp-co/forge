import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { describe, expect, it } from 'vitest';
import { firstRequirementRefusals, linkedDesignIds } from './first-requirement-rules.js';

const journey = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const approved = (id: string, flow = id) => ({ id, flow, designStatus: 'approved' });
const codes = (r: { code: string }[]) => r.map((x) => x.code);

describe('a first requirement links only approved designs, one per journey (project-onboarding requirements)', () => {
  it('passes a journey and another approved design it serves', () => {
    expect(
      firstRequirementRefusals({
        target: { type: 'workflow', id: journey },
        named: [other],
        designs: [approved(journey), approved(other)],
        journeyTwin: null,
      }),
    ).toEqual([]);
  });

  it('refuses a design that is not approved by name', () => {
    const r = firstRequirementRefusals({
      target: { type: 'workflow', id: journey },
      named: [other],
      designs: [approved(journey), { id: other, flow: 'billing', designStatus: 'proposed' }],
      journeyTwin: null,
    });
    expect(codes(r)).toEqual(['SUGGESTION_DESIGN_NOT_APPROVED']);
    expect(r[0]?.path).toBe('/payload/designs/0');
    expect(r[0]?.detail).toContain('billing reads proposed');
  });

  it('refuses a journey that is not approved at the target', () => {
    const r = firstRequirementRefusals({
      target: { type: 'workflow', id: journey },
      named: undefined,
      designs: [{ id: journey, flow: 'j', designStatus: null }],
      journeyTwin: null,
    });
    expect(codes(r)).toEqual(['SUGGESTION_DESIGN_NOT_APPROVED']);
    expect(r[0]?.path).toBe('/target');
  });

  it('refuses a design the project does not hold', () => {
    const r = firstRequirementRefusals({
      target: { type: 'workflow', id: journey },
      named: [other],
      designs: [approved(journey)],
      journeyTwin: null,
    });
    expect(codes(r)).toEqual(['SUGGESTION_DESIGN_UNKNOWN']);
  });

  it('refuses a second requirement on a journey', () => {
    const r = firstRequirementRefusals({
      target: { type: 'workflow', id: journey },
      named: undefined,
      designs: [approved(journey)],
      journeyTwin: { id: 's1', status: 'accepted' },
    });
    expect(codes(r)).toEqual(['SUGGESTION_JOURNEY_SUGGESTED']);
    expect(r[0]?.detail).toContain('s1');
  });

  it('refuses designs on a draft that targets an issue', () => {
    const r = firstRequirementRefusals({
      target: { type: 'issue', id: 'i1' },
      named: [other],
      designs: [],
      journeyTwin: null,
    });
    expect(codes(r)).toEqual(['SUGGESTION_PAYLOAD_INVALID']);
    expect(
      firstRequirementRefusals({
        target: { type: 'issue', id: 'i1' },
        named: undefined,
        designs: [],
        journeyTwin: null,
      }),
    ).toEqual([]);
  });

  it('links the journey first and each design once', () => {
    expect(linkedDesignIds(journey, [other, journey, other])).toEqual([journey, other]);
  });

  it('a requirement draft may target a journey design', () => {
    expect(SUGGESTION_PAYLOADS.requirement_draft.targets).toContain('workflow');
    expect(
      SUGGESTION_PAYLOADS.requirement_draft.schema.safeParse({
        title: 'Book a slot',
        reason: 'the booking journey is approved',
        criteria: [{ body: 'a booked slot is held for 10 minutes' }],
        designs: ['not-a-uuid'],
      }).success,
    ).toBe(false);
  });
});

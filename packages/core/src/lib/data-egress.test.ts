import { describe, expect, it } from 'vitest';
import { egressDeep, egressOf, storedAnswers, storedText } from './data-egress.js';

const patient =
  'Bệnh nhân Nguyễn Văn An, SĐT 0912 345 678, an.nguyen@gmail.com, tái khám 2026-10-03'; // i18n-allow: Vietnamese patient text is what the scrubber is for

describe('the one egress guard (Q8)', () => {
  it('off: content leaves as written and is stored as written', () => {
    expect(egressOf('off', patient, 'FB-1')).toEqual({ ok: true, text: patient, redactions: 0 });
    expect(storedText('off', patient).scrubbed).toBe(false);
  });

  it('redact: only scrubbed text leaves, and the date survives', () => {
    const out = egressOf('redact', patient, 'FB-1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).not.toContain('0912');
    expect(out.text).not.toContain('gmail');
    expect(out.text).not.toContain('Nguyễn'); // i18n-allow: a Vietnamese name the scrub must remove
    expect(out.text).toContain('2026-10-03');
  });

  it('no_egress: nothing leaves, refused CONTENT_EGRESS_FORBIDDEN naming the item', () => {
    const out = egressOf('no_egress', patient, 'FB-7');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.code).toBe('CONTENT_EGRESS_FORBIDDEN');
    expect(out.refusal.detail).toContain('FB-7');
    expect(egressDeep('no_egress', { a: 'x' }, 'REQ-1').ok).toBe(false);
  });

  it('redact and no_egress both scrub on write for storage', () => {
    expect(storedText('redact', patient).text).not.toContain('0912');
    expect(storedText('no_egress', patient).text).not.toContain('gmail');
  });

  it('a structured answer keeps its ids and times whole while its prose is scrubbed', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const out = egressDeep(
      'redact',
      { id, at: '2026-10-03T01:02:03.000Z', body: patient },
      'REQ-1',
    );
    expect(out.ok && out.value.id).toBe(id);
    expect(out.ok && out.value.at).toBe('2026-10-03T01:02:03.000Z');
    expect(out.ok && out.value.body).not.toContain('0912');
  });
});

describe('the onboarding_answers exemption (owner ruling 2026-10-04)', () => {
  const batch = (over: { onboardingId: string | null; requirementId: string | null }) => ({
    id: '9f1c2b3a-0000-4000-8000-000000000001',
    ...over,
    items: [{ id: 'hospital', prompt: 'Which hospital?', answer: { text: patient } }],
  });
  const onboarding = batch({ onboardingId: 'o-1', requirementId: null });
  const clarification = batch({ onboardingId: null, requirementId: 'r-1' });

  it('a typed answer is scrubbed on write at redact and no_egress; a choice id is kept', () => {
    const given = [
      { itemId: 'a', text: patient },
      { itemId: 'b', choice: 'hospital-a' },
    ];
    for (const level of ['redact', 'no_egress'] as const) {
      const [typed, picked] = storedAnswers(level, given);
      expect(typed?.text).not.toContain('0912');
      expect(typed?.text).not.toContain('gmail');
      expect(picked).toEqual(given[1]);
    }
    expect(storedAnswers('off', given)).toEqual(given);
  });

  it('no_egress: an onboarding answer is readable, and comes back scrubbed', () => {
    const out = egressDeep(
      'no_egress',
      [onboarding],
      'the onboarding answers',
      'onboarding_answers',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const text = out.value[0]?.items[0]?.answer.text ?? '';
    expect(text).not.toContain('0912');
    expect(text).not.toContain('gmail');
    expect(text).toContain('2026-10-03');
    expect(out.value[0]?.id).toBe(onboarding.id);
  });

  it('no_egress: a feedback body is still refused, and so is unclassed onboarding text', () => {
    const body = egressOf('no_egress', patient, 'FB-9');
    expect(body.ok).toBe(false);
    if (body.ok) return;
    expect(body.refusal.code).toBe('CONTENT_EGRESS_FORBIDDEN');
    expect(egressDeep('no_egress', { body: patient }, 'FB-9').ok).toBe(false);
    expect(egressDeep('no_egress', [onboarding], 'the onboarding answers').ok).toBe(false);
  });

  it('a BA clarification batch never qualifies: refused by name at no_egress, alone or mixed in', () => {
    for (const value of [[clarification], [onboarding, clarification], clarification]) {
      const out = egressDeep('no_egress', value, 'REQ-4 answers', 'onboarding_answers');
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.refusal.code).toBe('CONTENT_EGRESS_FORBIDDEN');
      expect(out.refusal.detail).toContain(clarification.id);
      expect(out.refusal.detail).toContain('not a batch of an onboarding conversation');
    }
    expect(egressDeep('no_egress', [clarification], 'REQ-4 answers').ok).toBe(false);
    for (const value of [[undefined, clarification], [undefined, onboarding], [null]]) {
      expect(egressDeep('no_egress', value, 'REQ-4 answers', 'onboarding_answers').ok).toBe(false);
    }
  });

  it('the class is refused when mislabelled at every level, so it cannot launder content at off', () => {
    expect(egressDeep('off', [clarification], 'REQ-4', 'onboarding_answers').ok).toBe(false);
    expect(egressDeep('redact', [{ body: patient }], 'FB-9', 'onboarding_answers').ok).toBe(false);
    expect(egressDeep('off', [onboarding], 'the onboarding answers', 'onboarding_answers')).toEqual(
      {
        ok: true,
        value: [onboarding],
      },
    );
  });
});

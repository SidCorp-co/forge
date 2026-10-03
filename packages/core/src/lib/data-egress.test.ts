import { describe, expect, it } from 'vitest';
import { feedbackEgress } from '../feedback/read.js';
import { questionnaireSurface } from '../questionnaires/read.js';
import {
  EGRESS_SURFACES,
  type EgressSurface,
  egressAt,
  egressOr,
  egressText,
  storedAnswers,
  storedText,
  withheldAt,
} from './data-egress.js';

const patient =
  'Bệnh nhân Nguyễn Văn An, SĐT 0912 345 678, an.nguyen@gmail.com, tái khám 2026-10-03'; // i18n-allow: Vietnamese patient text is what the scrubber is for

const surfacesOf = (cls: 'product' | 'operational') =>
  (Object.keys(EGRESS_SURFACES) as EgressSurface[]).filter((s) => EGRESS_SURFACES[s].class === cls);

describe('the surface table is the one place a class is declared', () => {
  it('names the product and operational surfaces the decision on ISS-59 lists', () => {
    expect(surfacesOf('product')).toEqual(
      expect.arrayContaining([
        'requirement',
        'design',
        'issue',
        'issue.criteria',
        'onboarding.answers',
      ]),
    );
    expect(surfacesOf('operational')).toEqual(
      expect.arrayContaining([
        'feedback',
        'feedback.attachments',
        'feedback.comments',
        'conversation',
        'requirement.clarification',
      ]),
    );
  });

  it('refuses a surface the table does not declare, by name, at every level', () => {
    for (const level of ['off', 'redact', 'no_egress'] as const) {
      const out = egressAt(level, 'not.declared' as EgressSurface, { a: 'x' }, 'the probe');
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.refusal.code).toBe('EGRESS_SURFACE_UNDECLARED');
      expect(out.refusal.detail).toContain('not.declared');
      expect(out.refusal.detail).toContain('EGRESS_SURFACES');
    }
  });
});

describe('product surfaces: readable at every level, scrubbed at redact and no_egress', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const value = { id, at: '2026-10-03T01:02:03.000Z', body: patient };

  it('off: leaves as written', () => {
    expect(egressAt('off', 'requirement', value)).toEqual({ ok: true, value });
  });

  it.each(['redact', 'no_egress'] as const)('%s: leaves scrubbed, ids and times whole', (level) => {
    for (const surface of surfacesOf('product')) {
      const out = egressAt(level, surface, value);
      expect(out.ok, surface).toBe(true);
      if (!out.ok) continue;
      expect(out.value.id).toBe(id);
      expect(out.value.at).toBe(value.at);
      expect(out.value.body).not.toContain('0912');
      expect(out.value.body).not.toContain('gmail');
      expect(out.value.body).toContain('2026-10-03');
      expect(withheldAt(level, surface)).toBe(false);
    }
  });
});

describe('operational surfaces: scrubbed at redact, withheld at no_egress', () => {
  it('off: leaves as written; redact: leaves scrubbed', () => {
    for (const surface of surfacesOf('operational')) {
      expect(egressAt('off', surface, { body: patient })).toEqual({
        ok: true,
        value: { body: patient },
      });
      const out = egressAt('redact', surface, { body: patient });
      expect(out.ok && out.value.body, surface).not.toContain('0912');
    }
  });

  it('no_egress: refused CONTENT_EGRESS_FORBIDDEN naming the item, and the caller answers metadata', () => {
    for (const surface of surfacesOf('operational')) {
      const out = egressAt('no_egress', surface, { body: patient }, 'FB-7');
      expect(out.ok, surface).toBe(false);
      if (out.ok) continue;
      expect(out.refusal.code).toBe('CONTENT_EGRESS_FORBIDDEN');
      expect(out.refusal.detail).toContain('FB-7');
      expect(withheldAt('no_egress', surface)).toBe(true);
      expect(egressOr(out, { key: 'FB-7' })).toEqual({ key: 'FB-7', withheld: out.refusal });
    }
  });

  it('egressText holds the same line for a passage a provider embeds', () => {
    expect(egressText('no_egress', 'feedback', patient, 'FB-9').ok).toBe(false);
    const redacted = egressText('redact', 'feedback', patient, 'FB-9');
    expect(redacted.ok && redacted.text).not.toContain('0912');
    expect(redacted.ok && redacted.redactions).toBeGreaterThan(0);
    const spec = egressText('no_egress', 'requirement', patient, 'REQ-1');
    expect(spec.ok && spec.text).not.toContain('gmail');
  });
});

describe('a questionnaire takes its class from its own arc, never from the caller', () => {
  const batch = (onboardingId: string | null, requirementId: string | null) => ({
    onboardingId,
    requirementId,
    items: [{ id: 'hospital', prompt: 'Which hospital?', answer: { text: patient } }],
  });

  it('an onboarding round is product: readable at no_egress, scrubbed', () => {
    const b = batch('o-1', null);
    expect(questionnaireSurface(b)).toBe('onboarding.answers');
    const out = egressAt('no_egress', questionnaireSurface(b), b);
    expect(out.ok).toBe(true);
    expect(out.ok && out.value.items[0]?.answer.text).not.toContain('0912');
  });

  it('a BA clarification on a requirement is operational: withheld at no_egress, alone or among others', () => {
    const clarification = batch(null, 'r-1');
    expect(questionnaireSurface(clarification)).toBe('requirement.clarification');
    expect(egressAt('no_egress', questionnaireSurface(clarification), clarification).ok).toBe(
      false,
    );
    expect(questionnaireSurface(batch('o-1', 'r-1'))).toBe('requirement.clarification');
    expect(questionnaireSurface(batch(null, null))).toBe('conversation');
  });
});

describe('the write side scrubs at redact and no_egress for every class', () => {
  it('stored text', () => {
    expect(storedText('off', patient).scrubbed).toBe(false);
    expect(storedText('redact', patient).text).not.toContain('0912');
    expect(storedText('no_egress', patient).text).not.toContain('gmail');
  });

  it('a typed answer is scrubbed, a choice id is kept', () => {
    const given = [
      { itemId: 'a', text: patient },
      { itemId: 'b', choice: 'hospital-a' },
    ];
    for (const level of ['redact', 'no_egress'] as const) {
      const [typed, picked] = storedAnswers(level, given);
      expect(typed?.text).not.toContain('0912');
      expect(picked).toEqual(given[1]);
    }
    expect(storedAnswers('off', given)).toEqual(given);
  });
});

describe('an agent read of feedback holds the operational line (planted red: remove the feedback row)', () => {
  it('no_egress: an agent, or any reader on the MCP door, gets metadata only', () => {
    expect(feedbackEgress('no_egress', 'agent').withhold).toBe(true);
    expect(feedbackEgress('no_egress', 'human', { providerBound: true }).withhold).toBe(true);
    expect(feedbackEgress('no_egress', 'human').withhold).toBe(false);
  });

  it('redact: an agent reads it scrubbed; off: as written', () => {
    const redacted = feedbackEgress('redact', 'agent');
    expect(redacted.withhold).toBe(false);
    expect(redacted.shown({ body: patient }, 'FB-1').body).not.toContain('0912');
    expect(feedbackEgress('off', 'agent').shown({ body: patient }, 'FB-1').body).toBe(patient);
  });

  it('the withheld read is refused for being operational, not for being undeclared', () => {
    const out = egressAt('no_egress', 'feedback', { body: patient }, 'FB-1');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal.code).toBe('CONTENT_EGRESS_FORBIDDEN');
    expect(EGRESS_SURFACES.feedback.class).toBe('operational');
  });
});

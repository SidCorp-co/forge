import { describe, expect, it } from 'vitest';
import { egressDeep, egressOf, storedText } from './data-egress.js';

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

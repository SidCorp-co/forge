import { describe, expect, it } from 'vitest';
import { submitStateRefusal } from './rules.js';

// REQ-10 BC-9 (ISS-603): the superseded refusal reads the batch that stands at the end of the
// replacements, and sends the person to it only while it takes answers
const superseded = {
  id: 'A',
  status: 'superseded' as const,
  round: 1,
  submittedAt: null,
  supersededAt: new Date('2026-10-22T07:00:00Z'),
  supersededReason: 'superseded by re-analysis',
  supersededBy: 'B',
};
const batch = (id: string, status: 'open' | 'skipped' | 'submitted' | 'superseded') => ({
  id,
  status,
  submittedAt: status === 'submitted' ? new Date('2026-10-22T08:00:00Z') : null,
});
const detailOf = (replacements: ReturnType<typeof batch>[]) => {
  const r = submitStateRefusal(superseded, false, replacements);
  expect(r?.code).toBe('QUESTIONNAIRE_SUPERSEDED');
  expect(r?.path).toBe('');
  return r?.detail ?? '';
};

describe('submitStateRefusal: a superseded batch', () => {
  it('names an open replacement as the one to answer', () => {
    expect(detailOf([batch('B', 'open')])).toBe(
      'batch A was superseded at 2026-10-22T07:00:00.000Z (superseded by re-analysis); batch B replaced it. Answer batch B instead.',
    );
  });

  it('names a replacement skipped for now, which still takes answers', () => {
    expect(detailOf([batch('B', 'skipped')])).toContain('Answer batch B instead.');
  });

  it('never sends the person to a replacement already answered', () => {
    const detail = detailOf([batch('B', 'submitted')]);
    expect(detail).not.toMatch(/answer (batch|that)/i);
    expect(detail).toContain(
      'batch B replaced it, and batch B was already answered at 2026-10-22T08:00:00.000Z, so this thread holds no batch to answer. What stayed open comes back in the next round.',
    );
  });

  it('walks a chain to the batch that stands, naming each step', () => {
    expect(detailOf([batch('B', 'superseded'), batch('C', 'open')])).toContain(
      'batch B replaced it, batch C replaced that. Answer batch C instead.',
    );
    expect(detailOf([batch('B', 'superseded'), batch('C', 'submitted')])).not.toMatch(
      /answer batch/i,
    );
  });

  it('says no batch stands yet where the last replacement was superseded with none after it', () => {
    const detail = detailOf([batch('B', 'superseded')]);
    expect(detail).toContain('batch B was superseded too; no batch has replaced it yet');
    expect(detail).not.toMatch(/answer batch/i);
  });

  it('says no batch has replaced it yet where none has', () => {
    const detail = submitStateRefusal({ ...superseded, supersededBy: null }, false, [])?.detail;
    expect(detail).toBe(
      'batch A was superseded at 2026-10-22T07:00:00.000Z (superseded by re-analysis); no batch has replaced it yet; the next one comes after the analysis.',
    );
  });

  it('leaves an open batch alone, and refuses an answered one ALREADY_ANSWERED', () => {
    expect(
      submitStateRefusal({ ...superseded, status: 'open', supersededBy: null }, false, []),
    ).toBe(null);
    expect(
      submitStateRefusal(
        { ...superseded, status: 'submitted', supersededBy: null, submittedAt: new Date() },
        false,
        [],
      )?.code,
    ).toBe('QUESTIONNAIRE_ALREADY_ANSWERED');
  });
});

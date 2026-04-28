import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { STATUS_TO_SKILL, resolveSkillForStatus } from './skill-mapping.js';

describe('pipeline/skill-mapping', () => {
  it('maps every automatable status to a skill + toggle', () => {
    expect(resolveSkillForStatus('open')).toEqual({ type: 'triage', toggle: 'autoTriage' });
    expect(resolveSkillForStatus('confirmed')).toEqual({ type: 'plan', toggle: 'autoPlan' });
    expect(resolveSkillForStatus('approved')).toEqual({ type: 'code', toggle: 'autoCode' });
    expect(resolveSkillForStatus('developed')).toEqual({ type: 'review', toggle: 'autoReview' });
    expect(resolveSkillForStatus('testing')).toEqual({ type: 'test', toggle: 'autoTest' });
    expect(resolveSkillForStatus('reopen')).toEqual({ type: 'fix', toggle: 'autoFix' });
    expect(resolveSkillForStatus('released')).toEqual({ type: 'release', toggle: 'autoRelease' });
  });

  it('returns null for human-gated statuses', () => {
    for (const s of ['waiting', 'staging', 'on_hold', 'needs_info', 'closed'] as const) {
      expect(resolveSkillForStatus(s)).toBeNull();
    }
  });

  it('covers only automatable statuses (snapshot check against drift)', () => {
    const mapped = Object.keys(STATUS_TO_SKILL).sort();
    expect(mapped).toEqual(
      ['approved', 'confirmed', 'developed', 'open', 'released', 'reopen', 'testing'].sort(),
    );
    // Every mapped key is a valid IssueStatus
    for (const key of mapped) {
      expect(issueStatuses).toContain(key as never);
    }
  });
});

import { feedbackTriageSchema } from '@forge/contracts/feedback';
import { describe, expect, it } from 'vitest';
import { carrierBands } from './triage.js';

describe('the issue route files its carrier with the bands the triager names', () => {
  it('takes complexity, category and priority in createIssue, so no write follows the route', () => {
    const parsed = feedbackTriageSchema.safeParse({
      route: 'issue',
      createIssue: { title: 'Fix it', complexity: 'm', category: 'chore', priority: 'low' },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const bands = carrierBands(
      { severity: 'high', kind: 'bug' },
      parsed.success ? parsed.data.createIssue : undefined,
    );
    expect(bands).toEqual({ priority: 'low', category: 'chore', complexity: 'm' });
  });

  it('keeps the bands the item implies where the triager names none', () => {
    expect(carrierBands({ severity: 'critical', kind: 'bug' }, {})).toEqual({
      priority: 'critical',
      category: 'bug',
      complexity: null,
    });
    expect(carrierBands({ severity: 'low', kind: 'idea' }, undefined).category).toBe('feature');
  });

  it('still refuses an unknown key by name, and a complexity outside the bands', () => {
    const stray = feedbackTriageSchema.safeParse({ route: 'issue', createIssue: { effort: 3 } });
    expect(stray.success).toBe(false);
    expect(JSON.stringify(stray.error?.issues)).toContain('effort');
    const band = feedbackTriageSchema.safeParse({
      route: 'issue',
      createIssue: { complexity: 'xxl' },
    });
    expect(band.success).toBe(false);
    expect(JSON.stringify(band.error?.issues)).toContain('complexity');
  });
});

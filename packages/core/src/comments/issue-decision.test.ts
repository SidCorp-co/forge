import { describe, expect, it } from 'vitest';
import { commentCreateSchema } from './body-input.js';
import { decisionBody } from './service.js';

describe('an owner records a decision on an issue unprompted', () => {
  it('the issue comment door takes decision fields with no body', () => {
    const parsed = commentCreateSchema.safeParse({
      intent: 'decision',
      decision: { decision: 'HOP takes the hospital CRM scope', reason: 'HOP settled points win' },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a blank decision or reason by shape, and an unknown field by name', () => {
    expect(
      commentCreateSchema.safeParse({
        intent: 'decision',
        decision: { decision: ' ', reason: 'r' },
      }).success,
    ).toBe(false);
    expect(commentCreateSchema.safeParse({ body: 'x', ruling: 'y' }).success).toBe(false);
  });

  it('the body every reader of the thread reads writes the decision and its reason out', () => {
    const body = decisionBody({ decision: 'Build REQ-26 first', reason: 'Leads feed it' });
    expect(body).toBe('**Decision:** Build REQ-26 first\n\n**Reason:** Leads feed it');
  });
});

import { describe, expect, it } from 'vitest';
import { buildChatToolContext } from './principal.js';

describe('buildChatToolContext', () => {
  it('fences the principal to the one project and carries the read scope the read handlers check', () => {
    const ctx = buildChatToolContext({ userId: 'u1', projectId: 'p1', projectSlug: 'proj' });
    expect(ctx.boundProjectId).toBe('p1');
    const principal = ctx.principal;
    if (principal.kind !== 'pat') throw new Error('chat principal must be PAT-shaped');
    expect(principal.projectIds).toEqual(['p1']);
    expect(principal.scopes).toEqual(['read']);
    expect(principal.agency).toBe('agent');
    expect(ctx.device.ownerId).toBe('u1');
  });
});

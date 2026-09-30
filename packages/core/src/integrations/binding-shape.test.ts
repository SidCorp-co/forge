import { describe, expect, it } from 'vitest';
import { bindingRoles } from '../db/release-axes.js';
import { roleSchema } from './binding-shape.js';

describe('binding roles', () => {
  it('holds source beside deploy and service', () => {
    expect(bindingRoles).toEqual(['deploy', 'service', 'source']);
  });

  it('keeps the integrations doors at deploy and service: a source binding is written as a binding document', () => {
    expect(roleSchema.safeParse('deploy').success).toBe(true);
    expect(roleSchema.safeParse('service').success).toBe(true);
    const source = roleSchema.safeParse('source');
    expect(source.success).toBe(false);
    expect(source.error?.issues[0]?.message).toContain('deploy');
  });
});

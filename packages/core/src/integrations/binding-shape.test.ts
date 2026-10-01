import { describe, expect, it } from 'vitest';
import { bindingRoles } from '../db/release-axes.js';

describe('binding roles', () => {
  it('holds source beside deploy and service', () => {
    expect(bindingRoles).toEqual(['deploy', 'service', 'source']);
  });
});

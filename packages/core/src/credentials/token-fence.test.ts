import { describe, expect, it } from 'vitest';
import { fenceReaches, tokenFence } from './token-fence.js';

const P = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';

describe('tokenFence', () => {
  it('reads a bound project as that project alone, whatever the list says', () => {
    expect(tokenFence({ boundProjectId: P, projectIds: null })).toEqual([P]);
    expect(tokenFence({ boundProjectId: P, projectIds: [Q] })).toEqual([P]);
  });

  it('reads an empty list as reaching nothing and no list as no fence', () => {
    expect(tokenFence({ boundProjectId: null, projectIds: [] })).toEqual([]);
    expect(tokenFence({ boundProjectId: null, projectIds: null })).toBeNull();
  });
});

describe('fenceReaches', () => {
  it('reaches every project with no fence, none with an empty one, and only the listed ones else', () => {
    expect(fenceReaches(null, P)).toBe(true);
    expect(fenceReaches([], P)).toBe(false);
    expect(fenceReaches([P], P)).toBe(true);
    expect(fenceReaches([Q], P)).toBe(false);
  });
});

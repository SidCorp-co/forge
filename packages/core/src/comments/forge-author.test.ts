import { describe, expect, it } from 'vitest';
import { FORGE_AUTHOR_ID, userActor } from './forge-author.js';

describe('userActor (ISS-1421)', () => {
  it('reads Forge as the agent it is', () => {
    expect(userActor(FORGE_AUTHOR_ID)).toEqual({
      type: 'user',
      id: FORGE_AUTHOR_ID,
      agency: 'agent',
    });
  });

  it('leaves anyone else as they stand, for the transition to read', () => {
    expect(userActor('person-1')).toEqual({ type: 'user', id: 'person-1' });
  });
});

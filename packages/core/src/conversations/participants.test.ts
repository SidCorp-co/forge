// ISS-1229 r32 (judge-90): an agent marked "can't act" for holding no token answered in its room.

import { describe, expect, it } from 'vitest';
import { answersHere } from './participants.js';

describe('whether a member of a room can answer in it', () => {
  it('holds for an agent with a role on the project it was added for, whatever tokens it holds', () => {
    expect(answersHere('handle', 'member')).toBe(true);
    expect(answersHere('handle', 'viewer')).toBe(true);
  });

  it('fails for an agent that lost its role on that project', () => {
    expect(answersHere('handle', null)).toBe(false);
  });

  it('is not a question asked of a person', () => {
    expect(answersHere('person', 'admin')).toBeNull();
    expect(answersHere('person', null)).toBeNull();
  });
});

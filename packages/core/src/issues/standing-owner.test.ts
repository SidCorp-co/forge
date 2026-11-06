/**
 * The steward is retired (ISS-1068): an issue its account filed and nobody was assigned names no
 * owner, never "Steward"; the master's take-on-or-drop is what its standing waits on. A person or
 * a live agent who filed one still owns it, and an assignee always does.
 *
 * @direct-test-of packages/core/src/issues/standing-owner.ts
 */

import { describe, expect, it } from 'vitest';
import { ownerIdOf } from './standing-owner.js';

describe('ownerIdOf', () => {
  it('names no owner for an unassigned issue a steward account filed', () => {
    expect(
      ownerIdOf({ assignee: null, creator: 'steward-user', creatorIsSteward: true }),
    ).toBeNull();
  });

  it('names the assignee whoever filed it', () => {
    expect(ownerIdOf({ assignee: 'lan', creator: 'steward-user', creatorIsSteward: true })).toBe(
      'lan',
    );
  });

  it('names the creator where it is not a steward account', () => {
    expect(ownerIdOf({ assignee: null, creator: 'forge-agent', creatorIsSteward: false })).toBe(
      'forge-agent',
    );
    expect(ownerIdOf({ assignee: null, creator: null, creatorIsSteward: false })).toBeNull();
  });
});

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
      ownerIdOf({
        assignee: null,
        creator: 'steward-user',
        creatorIsSteward: true,
        boxOwner: null,
      }),
    ).toBeNull();
  });

  it('names the assignee whoever filed it', () => {
    expect(
      ownerIdOf({
        assignee: 'lan',
        creator: 'steward-user',
        creatorIsSteward: true,
        boxOwner: null,
      }),
    ).toBe('lan');
  });

  it('names the creator where it is not a steward account', () => {
    expect(
      ownerIdOf({
        assignee: null,
        creator: 'forge-agent',
        creatorIsSteward: false,
        boxOwner: null,
      }),
    ).toBe('forge-agent');
    expect(
      ownerIdOf({ assignee: null, creator: null, creatorIsSteward: false, boxOwner: null }),
    ).toBeNull();
  });

  // the Owner column named the project's agent by its handle ("forge") beside its mark (ISS-1072):
  // an issue filed from a box is owned by the person who owns the box, an assignee still first
  it('names the person who owns the box an unassigned issue was filed from', () => {
    expect(
      ownerIdOf({
        assignee: null,
        creator: 'forge-agent',
        creatorIsSteward: false,
        boxOwner: 'lan',
      }),
    ).toBe('lan');
    expect(
      ownerIdOf({
        assignee: 'an',
        creator: 'forge-agent',
        creatorIsSteward: false,
        boxOwner: 'lan',
      }),
    ).toBe('an');
    expect(
      ownerIdOf({
        assignee: null,
        creator: 'steward-user',
        creatorIsSteward: true,
        boxOwner: 'lan',
      }),
    ).toBeNull();
  });
});

/**
 * The owner record is kernel state — who holds a release, and how that ended — so a record that is
 * present and malformed is refused by name, never read as the absence that means "cut before
 * ISS-1281, its job owns it".
 */

import { describe, expect, it } from 'vitest';
import {
  awaitingOwner,
  RELEASE_OWNER_KEY,
  ReleaseOwnerUnreadableError,
  readBrief,
  readOwner,
  withRefusal,
} from './owner-record.js';

const NOW = new Date('2026-09-30T10:00:00.000Z');

describe('readOwner', () => {
  it('reads a batch cut before owners existed as having none', () => {
    expect(readOwner({ source: 'release-batch' }, 'run-1')).toBeNull();
    expect(readOwner(null, 'run-1')).toBeNull();
  });

  it('reads back what awaitingOwner wrote', () => {
    const owner = awaitingOwner(NOW, 30 * 60_000);
    expect(readOwner({ [RELEASE_OWNER_KEY]: owner }, 'run-1')).toEqual(owner);
    expect(owner.deadlineAt).toBe('2026-09-30T10:30:00.000Z');
    expect(owner.state).toBe('awaiting');
  });

  it('refuses a record in a state no code writes, naming the run and the field', () => {
    const bad = { ...awaitingOwner(NOW, 1000), state: 'taken' };
    expect(() => readOwner({ [RELEASE_OWNER_KEY]: bad }, 'run-7')).toThrow(
      ReleaseOwnerUnreadableError,
    );
    expect(() => readOwner({ [RELEASE_OWNER_KEY]: bad }, 'run-7')).toThrow(/run-7.*state/);
  });

  it('refuses a record that is not an object at all rather than reading it as absent', () => {
    expect(() => readOwner({ [RELEASE_OWNER_KEY]: 'owned' }, 'run-1')).toThrow(
      /RELEASE_OWNER_UNREADABLE/,
    );
  });
});

describe('withRefusal', () => {
  it('keeps the newest ten, oldest dropped first', () => {
    let owner = awaitingOwner(NOW, 1000);
    for (let i = 0; i < 12; i++) {
      owner = withRefusal(owner, { at: `t${i}`, deviceId: 'd', deviceName: null, reason: `r${i}` });
    }
    expect(owner.refusals).toHaveLength(10);
    expect(owner.refusals[0]?.reason).toBe('r2');
    expect(owner.refusals[9]?.reason).toBe('r11');
  });
});

describe('readBrief', () => {
  it('reads the stored prompt, and nothing where none was written', () => {
    expect(readBrief({ brief: '## Batch Release' })).toBe('## Batch Release');
    expect(readBrief({ brief: '' })).toBeNull();
    expect(readBrief({})).toBeNull();
  });
});

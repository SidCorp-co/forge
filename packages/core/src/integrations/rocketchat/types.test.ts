/**
 * ISS-977 — the binding config declares what the connection manager reads.
 *
 * It declared `rid: string` while `connection-manager.ts` read `config.rids` as
 * a string array through a local cast, so the compiler never saw the two
 * disagree. These assertions are type-level: what they defend is that the
 * declaration stays the shape the reader uses, and `tsc` is what goes red.
 */

import { describe, expect, it } from 'vitest';
import type { RocketChatBindingConfig } from './types.js';

describe('RocketChatBindingConfig', () => {
  it('declares the room list the connection manager reads, under that name', () => {
    const config: RocketChatBindingConfig = { rids: ['room-a', 'room-b'] };
    expect(config.rids).toEqual(['room-a', 'room-b']);
  });

  it('admits a binding that names no room, which is how the manager skips one', () => {
    const config: RocketChatBindingConfig = {};
    expect(config.rids ?? []).toEqual([]);
  });
});

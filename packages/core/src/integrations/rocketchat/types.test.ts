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

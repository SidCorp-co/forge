// @direct-test-of packages/core/src/support/room-conduct.ts
import { describe, expect, it } from 'vitest';
import { FORGE_TOOLS_DEAD, roomConductLines } from './room-conduct.js';

// ISS-1480: an agent spawned during a core 503 held no forge tools for a day and told users "Forge
// 503"; it can only tell its own dead tool set from a dead core by what its brief says.
describe('the room brief tells a dead forge tool set from a dead core', () => {
  it('names the missing tools, the failed server and the core 5xx, once, in every room brief', () => {
    const lines = roomConductLines('http://w').filter((l) => l.includes('forge tools are missing'));
    expect(lines).toEqual([FORGE_TOOLS_DEAD]);
    expect(FORGE_TOOLS_DEAD).toContain('ToolSearch lists the forge server as failed');
    expect(FORGE_TOOLS_DEAD).toContain('core 5xx is core down');
  });
});

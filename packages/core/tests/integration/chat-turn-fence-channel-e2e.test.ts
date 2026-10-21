/**
 * The channel tool, from a chat turn, reads only what the person asking may (REQ-30 BC-10; workflow
 * design chat-turn r2, step `denied`): a notice between two projects the asker is in neither of
 * stays out of reach in both modes, and an ecosystem-scope chat widens only to the asker's own
 * projects.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChannelWorld, changeNotice, ok, openChannelWorld } from '../helpers/channel-world.js';
import { type FenceWorld, fenceWorld } from '../helpers/chat-fence-world.js';
import { closeWorld } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';

const cn = 'FP-CN-1';
let w: ChannelWorld;
let f: FenceWorld;

beforeAll(async () => {
  w = await openChannelWorld();
  f = await fenceWorld(w.app, { ...w.tokens });
  const forgeChannel = `/api/projects/${w.project.forge}/channel`;
  const made = ok(await f.say('masterForge', 'POST', `${forgeChannel}/drafts`, changeNotice(w)));
  ok(await f.say('masterForge', 'POST', `${forgeChannel}/documents/${made.id}/submit`));
  // the store side: in the ecosystem, and a party to nothing forge and plugin say
  await f.seat('store', w.user.store, w.project.store);
  // a person the ecosystem-scope chat widens for: a member of store and a viewer of plugin
  const bridge = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.project.store, bridge, 'member');
  await addProjectMember(w.project.plugin, bridge, 'viewer');
  await f.seat('bridge', bridge, w.project.store);
}, 180_000);

afterAll(closeWorld);

describe('the channel tool, from a chat turn, reads only what the asker may', () => {
  it('the forge and plugin sides read the notice they exchanged', async () => {
    for (const [who, project] of [
      ['platform', w.project.forge],
      ['plugin', w.project.plugin],
    ] as const) {
      const read = ok(await f.say(who, 'GET', `/api/projects/${project}/channel/documents/${cn}`));
      expect(read.document.number, who).toBe(cn);
    }
  });

  it('refuses, in process, a notice between two projects the asker is in neither of', async () => {
    const set = f.tools('store');
    const read = await set.execute('forge_channel', JSON.stringify({ action: 'read', ref: cn }));
    expect(read.isError, f.text(read)).toBe(true);
    expect(f.text(read)).toContain('CHANNEL_NOT_A_PARTY');
    const named = await set.execute(
      'forge_channel',
      JSON.stringify({ projectId: w.project.forge, action: 'inbox' }),
    );
    expect(named.isError, f.text(named)).toBeFalsy();
    expect(f.text(named)).not.toContain(cn);
    const register = await set.execute('forge_channel', JSON.stringify({ action: 'register' }));
    expect(register.isError, f.text(register)).toBeFalsy();
    expect(f.text(register)).not.toContain(cn);
  });

  it('refuses, on /mcp, an Agent session naming a project its token does not reach', async () => {
    const named = await f.callMcp('store:agent', 'forge_channel', {
      projectId: w.project.forge,
      action: 'read',
      ref: cn,
    });
    expect(named.result?.isError, JSON.stringify(named)).toBe(true);
    expect(JSON.stringify(named)).not.toContain(changeNotice(w).subject);
    const own = await f.callMcp('store:agent', 'forge_channel', { action: 'read', ref: cn });
    expect(JSON.stringify(own)).toContain('CHANNEL_NOT_A_PARTY');
  });

  it("widens an ecosystem-scope chat only to the asker's own projects", async () => {
    const scoped = { ecosystemId: w.eco };
    const outsider = await f
      .tools('store', scoped)
      .execute('forge_channel', JSON.stringify({ action: 'register' }));
    expect(outsider.isError, f.text(outsider)).toBeFalsy();
    expect(f.text(outsider)).not.toContain(cn);
    const read = await f
      .tools('store', scoped)
      .execute('forge_channel', JSON.stringify({ action: 'read', ref: cn }));
    expect(f.text(read)).toContain('CHANNEL_NOT_A_PARTY');
    const bridged = await f
      .tools('bridge', scoped)
      .execute('forge_channel', JSON.stringify({ action: 'read', ref: cn }));
    expect(bridged.isError, f.text(bridged)).toBeFalsy();
    expect(f.text(bridged)).toContain(cn);
  });
});

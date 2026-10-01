import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  ok,
  openChannelWorld,
  rfi,
  type Speaker,
  speaker,
} from '../helpers/channel-world.js';
import type { Doc } from '../helpers/ecosystem-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;
let number = '';
let question = '';

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  const eco = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}`));
  eco.document.gate.rfi = 'approve';
  ok(
    await say('platform', 'PUT', `/api/ecosystems/${w.eco}`, {
      baseRevision: eco.revision,
      document: eco.document,
    }),
  );
  const base = `/api/projects/${w.project.forge}/channel`;
  const draft = ok(await say('masterForge', 'POST', `${base}/drafts`, rfi(w)));
  const sent = ok(await say('masterForge', 'POST', `${base}/documents/${draft.id}/submit`));
  expect(sent.document.state).toBe('submitted');
  number = sent.document.number;
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

const gates = async (who: Speaker): Promise<Doc[]> =>
  ok(await say(who, 'GET', '/api/me/attention')).channelGates;

describe('a document waiting at the approve gate reaches the attention of whoever may decide it', () => {
  it('lists the gate for an admin of the sending project, linking the document', async () => {
    const mine = await gates('platform');
    expect(mine).toEqual([
      expect.objectContaining({
        kind: 'channel_gate',
        documentNumber: number,
        link: `/projects/forge/ecosystem/channel/${number}`,
        projectSlug: 'forge',
        questionId: expect.any(String),
      }),
    ]);
    question = mine[0]?.questionId;
    const total = ok(await say('platform', 'GET', '/api/me/attention')).total;
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('lists nothing for a member of the sending project, whose role cannot choose an admin option', async () => {
    expect(await gates('forgeMember')).toEqual([]);
  });

  it('lists nothing for the recipient side, nor for a project outside the pair', async () => {
    expect(await gates('plugin')).toEqual([]);
    expect(await gates('viewer')).toEqual([]);
    expect(await gates('store')).toEqual([]);
  });

  it('leaves the list once the gate is decided', async () => {
    ok(
      await say('platform', 'POST', `/api/questions/${question}/answer`, {
        round: 1,
        optionId: 'return',
        note: 'Name the field the skill reads, not the module.',
      }),
    );
    expect(await gates('platform')).toEqual([]);
  });
});

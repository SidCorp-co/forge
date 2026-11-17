import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { createTestModule, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/term-act.ts
// @direct-test-of packages/core/src/support/term-cards.ts
// @direct-test-of packages/core/src/support/term-routes.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/support/room-conduct.ts
// @direct-test-of packages/contracts/src/support-terms.ts
//
// ISS-1256 c9 (owner 2026-11-16: "a person names a thing → write a term"): a room agent hearing a
// person call a thing by a word of their own had no door to write it, and its guide sent the word on
// through support.record, which files a defect, feature or request; forge-dev's glossary stayed
// empty. The room agent now writes the term itself, under the person's own Forge permission, their
// message quoted as who named it.

const w = new AgentWorld();

beforeAll(async () => {
  await w.openAgent();
  await createTestModule(w.projectId, 'execution');
  // alice's chat account is the Forge account that owns the project's organization; bob is nobody's
  const namespace = new URL(w.stand.serverUrl).host;
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespace}, ${w.stand.alice.userId}, ${w.stand.alice.username}, ${w.ownerId}, 'channel_email_match')`);
}, 120_000);

afterAll(() => w.stop());

type Entry = { kind: string; authored_by: string; module: string | null; term: unknown };
const glossary = () =>
  rows<Entry>(
    sql`SELECT e.kind, e.authored_by, l.slug AS module, e.term FROM knowledge_entries e
          LEFT JOIN labels l ON l.id = e.module_id
         WHERE e.project_id = ${w.projectId}::uuid AND e.kind = 'glossary' ORDER BY e.slug`,
  );

const term = (thread: string | undefined, message: string | undefined, module = 'execution') => ({
  action: 'term',
  thread,
  message,
  slug: 'run-slots',
  title: 'Run slots',
  means: 'How many subagent runs a project may hold at once on a box.',
  module,
  aliases: { vi: ['chia slot'], industry: ['fair-share scheduling'] },
  quote: 'how many chia slot does epod get?',
});

describe('a person’s own word for a thing is written as a term by the agent they said it to', () => {
  it('writes the glossary entry under its module, their word an alias and their message quoted', async () => {
    let wrote: Record<string, unknown> = {};
    let unknown: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, '@babo how many chia slot does epod get?'),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        unknown = await act(term(thread, id, 'billing'));
        wrote = await act(term(thread, id));
        await act({ action: 'reply', thread, text: 'Run slots: two for epod.' });
      },
    );
    expect(code(unknown)).toBe('MODULE_MAP_MODULE_UNKNOWN');
    expect(wrote.isError, JSON.stringify(wrote)).toBe(false);
    expect(wrote).toMatchObject({ term: 'run-slots', module: 'execution' });
    expect(await glossary()).toEqual([
      {
        kind: 'glossary',
        authored_by: 'agent',
        module: 'execution',
        term: {
          aliases: { vi: ['chia slot'], industry: ['fair-share scheduling'] },
          namedBy: { who: w.stand.alice.username, quote: 'how many chia slot does epod get?' },
        },
      },
    ]);
  });

  it('writes nothing for a writer Forge cannot name, saying why (negative)', async () => {
    let out: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.bob, '@babo we call the queue the waiting room'),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        out = await act({ ...term(thread, id), slug: 'waiting-room', title: 'Waiting room' });
        await act({ action: 'silent', thread, message: id, reason: 'not theirs to write' });
      },
    );
    expect(code(out)).toBe('OPS_ASKER_UNMAPPED');
    expect((await glossary()).length).toBe(1);
  });

  it('teaches the act on the map where the owner speaks', () => {
    expect(w.brief()).toContain('a word no term holds, write with support.term');
  });
});

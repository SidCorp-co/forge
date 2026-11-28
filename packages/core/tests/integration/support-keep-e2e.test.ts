import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/keep-act.ts
// @direct-test-of packages/core/src/support/keep-cards.ts
// @direct-test-of packages/core/src/support/keep-routes.ts
// @direct-test-of packages/core/src/support/kept-cases.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/contracts/src/support-keep.ts
//
// ISS-1485 (REQ-107 BC-5; owner ruling 2026-11-28): the room agent's own reads fell from 8 a day to 0
// or 1 on AdminHub because what it learned was kept nowhere it read again. It now keeps a summary
// as a project knowledge entry under its own account, and the turn that follows a message bearing on
// it is handed that summary, so the agent answers from it instead of asking the master.

const w = new AgentWorld();

beforeAll(async () => {
  await w.openAgent();
}, 120_000);

afterAll(() => w.stop());

type Entry = { slug: string; kind: string; authored_by: string; source: string; scope: string };
const kept = () =>
  rows<Entry>(
    sql`SELECT slug, kind, authored_by, source, scope FROM knowledge_entries
         WHERE project_id = ${w.projectId}::uuid AND slug LIKE 'case-%' ORDER BY slug`,
  );

const keep = (thread: string | undefined, topic = 'export-size-column') => ({
  action: 'keep',
  thread,
  topic,
  concerns: 'problem',
  title: 'CSV export drops the size column',
  learned:
    'The export drops the size column when a product has no variants. Cause: the variant join. The master fixed it for new exports; old files are exported again.',
  scope: 'the CSV export, products without variants',
  recheckWhen: 'the export or the variant model changes',
});

describe('a room agent keeps what it learned and is handed it when a later turn bears on it', () => {
  it('writes one summary as the agent’s own entry, with its scope and its source case', async () => {
    let wrote: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, '@babo the export lost the size column on our products'),
      async (_t, act, message) => {
        const { thread } = message();
        wrote = await act(keep(thread));
        await act({ action: 'reply', thread, text: 'It is fixed; re-export the file.' });
      },
    );
    expect(wrote.isError, JSON.stringify(wrote)).toBe(false);
    expect(wrote).toMatchObject({ kept: 'case-export-size-column', concerns: 'problem' });
    const [row] = await kept();
    expect(row).toMatchObject({
      slug: 'case-export-size-column',
      kind: 'guide',
      authored_by: 'agent',
      scope: 'the CSV export, products without variants',
    });
    expect(row?.source).toContain('thread ');
  });

  it('hands the kept summary to a later turn that bears on it, and not one that does not', async () => {
    const related = await w.hear(() =>
      w.stand.say(w.stand.bob, '@babo the CSV export drops the size column again'),
    );
    expect(related.turn.text).toContain('case-export-size-column');
    expect(related.turn.text).toContain('the variant join');
    const unrelated = await w.hear(() =>
      w.stand.say(w.stand.bob, '@babo how do I change my shop opening hours?'),
    );
    expect(unrelated.turn.text).not.toContain('case-export-size-column');
  });

  it('never rewrites an entry a person wrote, naming why (negative)', async () => {
    await rows(
      sql`INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection, confidence, authored_by, order_index, source, scope, recheck_when)
          VALUES (${w.projectId}::uuid, 'case-by-hand', 'By hand', 'A person wrote this.', 'guide', 'on_demand', 'verified', 'human', 0, 's', 'c', 'r')`,
    );
    let out: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, '@babo one more export thing'),
      async (_t, act, message) => {
        const { thread } = message();
        out = await act(keep(thread, 'by-hand'));
        await act({ action: 'silent', thread, message: message().message, reason: 'test' });
      },
    );
    expect(code(out)).toBe('SUPPORT_REFUSED');
    const [row] = await rows<{ authored_by: string; body: string }>(
      sql`SELECT authored_by, body FROM knowledge_entries WHERE project_id = ${w.projectId}::uuid AND slug = 'case-by-hand'`,
    );
    expect(row).toMatchObject({ authored_by: 'human', body: 'A person wrote this.' });
  });

  it('writes no precedent: the slug is always case-<topic> (boundary)', async () => {
    let out: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, '@babo and a precedent please'),
      async (_t, act, message) => {
        const { thread } = message();
        out = await act(keep(thread, 'precedent-refund'));
        await act({ action: 'silent', thread, message: message().message, reason: 'test' });
      },
    );
    expect(out.isError, JSON.stringify(out)).toBe(false);
    const slugs = (await kept()).map((r) => r.slug);
    expect(slugs).toContain('case-precedent-refund');
    expect(
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM knowledge_entries WHERE project_id = ${w.projectId}::uuid AND slug LIKE 'precedent-%'`,
        )
      )[0]?.n,
    ).toBe(0);
  });
});

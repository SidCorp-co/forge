import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

/**
 * ISS-1256 criterion 7: room bots search through the one find door. A room's `support.search` was
 * its own keyword recall over knowledge alone; now its records come through the find door over its
 * own project, filtered to the types a room reads (knowledge and the reference sources it follows),
 * and a search finding nothing is kept as the project's gap. The published API operations stay a
 * contract lookup beside it (`support-room-e2e` cites them).
 *
 * @direct-test-of packages/core/src/support/search.ts
 * @direct-test-of packages/core/src/knowledge-ports.ts
 * @direct-test-of packages/core/src/knowledge/ports.ts
 */

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1256 c7: a room searches through the find door', () => {
  it('searches the room’s records through the find door: a source it follows, a term by its alias, never an issue, and a miss is a gap (ISS-1256 c7)', async () => {
    await w.bind();
    await w.untilWarm();
    await db.execute(sql`
      INSERT INTO reference_sources (org_id, project_id, kind, url, title, why, areas, priority,
                                     origin, added_by, added_agency)
      VALUES ((SELECT org_id FROM projects WHERE id = ${w.projectId}), ${w.projectId}, 'repo',
              'https://github.com/acme/stocktake', 'acme/stocktake', 'How a peer counts warehouse shelves',
              ARRAY['stock'], 1, 'added', ${w.ownerId}, 'human')`);
    // a term whose title and text never say the alias the room is asked by
    await db.execute(sql`
      INSERT INTO knowledge_entries (project_id, kind, slug, title, body, entry_type, term)
      VALUES (${w.projectId}, 'glossary', 'shelf-quantity', 'Shelf quantity',
              'What a product holds on its shelf now.', 'convention',
              ${JSON.stringify({ aliases: { vi: ['ton ke'] } })}::jsonb)`);
    // an issue holding the same words: an operations read, never a room search's hit
    await db.execute(sql`
      INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, priority)
      VALUES (${w.projectId}, 4001, 'Warehouse shelves miscounted', 'open', ${w.ownerId}, 'medium')`);
    const out: Record<string, unknown> = {};
    w.box.model = async (t, act) => {
      for (const m of t.messages) {
        if (m.from === 'forge') continue;
        out.shelves = await act({ action: 'search', query: 'warehouse shelves' });
        out.alias = await act({ action: 'search', query: 'ton ke' });
        out.miss = await act({ action: 'search', query: 'zzqx flarn vobble' });
        await act({ action: 'reply', thread: m.thread, text: 'searched' });
      }
    };
    const id = await w.chat.say(w.chat.alice, 'Where do the shelf counts come from?');
    await w.untilLines((ls) => ls.some((l) => l.tmid === id && l.text === 'searched'));
    const cites = (v: unknown) =>
      Object.values(v as Record<string, unknown>).flatMap((h) =>
        typeof h === 'object' && h !== null && 'cite' in h ? [String(h.cite)] : [],
      );
    const [source] = await rows<{ id: string }>(
      sql`SELECT id FROM reference_sources WHERE project_id = ${w.projectId} AND title = 'acme/stocktake'`,
    );
    expect(cites(out.shelves)).toContain(`reference:${source?.id}`);
    expect(JSON.stringify(out.shelves)).not.toContain('Warehouse shelves miscounted');
    expect(cites(out.alias)).toContain('knowledge:shelf-quantity');
    expect(cites(out.miss)).toEqual([]);
    const gaps = await rows<{ asked_by: string }>(sql`
      SELECT asked_by FROM find_misses WHERE project_id = ${w.projectId} AND query = 'zzqx flarn vobble'`);
    expect(gaps).toEqual([{ asked_by: 'agent' }]);
  });
});

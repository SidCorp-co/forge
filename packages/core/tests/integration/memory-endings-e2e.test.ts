/**
 * REQ-89 BC-5 (ISS-1156), against real Postgres: a temporary entry whose `endsWhen` a landing or a
 * rule's rewrite meets is retired; one naming an ending core cannot see is warned, and flagged once
 * its note window passes unchecked. The rest of the curation is `curated-memory-e2e.test.ts`.
 *
 * The embedder is a stand-in for the model: each distinct word is one dimension.
 *
 * @direct-test-of packages/core/src/memory/endings.ts
 * @direct-test-of packages/core/src/memory/note-lifetime.ts
 * @direct-test-of packages/core/src/memory/recheck.ts
 * @direct-test-of packages/core/src/memory/write-service.ts
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { retireLapsedNotes } from '../../src/memory/note-lifetime.js';
import { recheckForLanding } from '../../src/memory/recheck.js';
import {
  CURATED,
  openCuratedMemoryWorld,
  putKnowledge,
  w,
  write,
} from '../helpers/curated-memory-world.js';
import { wordVector } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => wordVector(text),
  embedQuery: async (_s: unknown, text: string) => wordVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(wordVector),
}));

openCuratedMemoryWorld();

describe('BC-5: a temporary entry is retired when what ends it happens', () => {
  const archived = async (id: string) => {
    const [row] = (await db.execute(sql`
      SELECT archived_at IS NOT NULL AS archived, metadata->>'archivedBy' AS "archivedBy",
             metadata->>'staleReason' AS "staleReason"
        FROM memories WHERE id = ${id}`)) as unknown as {
      archived: boolean;
      archivedBy: string | null;
      staleReason: string | null;
    }[];
    return row;
  };

  it('retires an entry ending on a path when a landing touches it, and leaves one ending elsewhere', async () => {
    const ends = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-on-schema',
      textContent: 'The decay sweep reads the schema file twice until it is split',
      ...CURATED,
      recheckWhen: 'the decay sweep changes',
      endsWhen: 'packages/core/src/db/schema-memory.ts is split',
    });
    const stays = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-elsewhere',
      textContent: 'The board widens the dock until the size control is pressed',
      ...CURATED,
      recheckWhen: 'the dock changes',
      endsWhen: 'packages/web-v2/src/features/chat-dock/dock.tsx changes',
    });
    const issueId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_paths)
      VALUES (${issueId}, ${w.projectId}, 42, 'split the memory schema', 'awaiting_release', ${w.userId}, now(),
              'bcd1234def5678abc1234def5678abc1234def56',
              ${JSON.stringify({ commit: 'bcd1234def5678abc1234def5678abc1234def56', changes: [{ path: 'packages/core/src/db/schema-memory.ts', change: 'modified' }] })}::jsonb)`);
    await recheckForLanding(w.projectId, issueId);
    expect(await archived(ends.body.id as string)).toMatchObject({
      archived: true,
      archivedBy: expect.stringContaining('ISS-42'),
    });
    expect(await archived(stays.body.id as string)).toMatchObject({ archived: false });
  });

  it('retires an entry ending on a rule when the rule is rewritten', async () => {
    const ends = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-on-rule',
      textContent: 'Masters hold one builder while the pace rule says so',
      ...CURATED,
      recheckWhen: 'the masters change',
      endsWhen: 'the rule `builder-cap` is rewritten',
    });
    await putKnowledge('builder-cap', {
      kind: 'rule',
      title: 'Builder cap',
      body: 'Three builders for forge',
      type: 'convention',
      source: 'owner',
      scope: 'every master',
      recheckWhen: 'the owner rules on the cap',
    });
    expect(await archived(ends.body.id as string)).toMatchObject({
      archived: true,
      archivedBy: expect.stringContaining('rule builder-cap'),
    });
  });

  it('warns an ending core cannot see, and flags the entry once its window passes unchecked', async () => {
    const unseen = await write({
      source: 'knowledge',
      sourceRef: 'gotcha/ends-on-plugin',
      textContent: 'The drive skill names the old phase endpoint until the plugin ships its fix',
      ...CURATED,
      recheckWhen: 'the drive skill changes',
      endsWhen: 'forge-plugin 0.9.3 ships',
    });
    expect(unseen.body.warnings).toEqual([
      expect.objectContaining({ code: 'ENDING_UNOBSERVED', path: '/endsWhen' }),
    ]);
    const seen = await write({
      source: 'knowledge',
      sourceRef: 'gotcha/ends-on-key',
      textContent: 'Notes past the window retire unless the window key is raised',
      ...CURATED,
      recheckWhen: 'the window changes',
      endsWhen: 'the policy key `memory.noteWindowDays` changes',
    });
    expect(seen.body.warnings).toBeUndefined();
    await db.execute(sql`
      UPDATE memories SET updated_at = now() - interval '40 days', created_at = now() - interval '40 days'
       WHERE id IN (${unseen.body.id as string}::uuid, ${seen.body.id as string}::uuid)`);
    await retireLapsedNotes();
    expect(await archived(unseen.body.id as string)).toMatchObject({
      archived: false,
      staleReason: expect.stringContaining('core cannot observe'),
    });
    expect(await archived(seen.body.id as string)).toMatchObject({
      archived: false,
      staleReason: null,
    });
  });
});

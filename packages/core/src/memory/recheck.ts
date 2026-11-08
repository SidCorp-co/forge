// REQ-89 BC-5 (ISS-1121): a curated memory names the change that means re-checking it
// (`curation.recheckWhen`). When a landing touches a path, route or config key it names, or a rule it
// names is rewritten, the memory is flagged with the release flag every reader already shows
// (`staleSince`, `supersededBy`, `staleReason`; `needsCheck` `flagged`), naming the change and the
// anchor it met. The next agent confirms it (`verify`), rewrites it (a write clears the flag) or
// retires it. An entry whose `endsWhen` the change meets has ended, and is retired (endings.ts). A landing also flags the project's knowledge and its org's rules the same way
// (`knowledge/recheck.ts`).

import { MEMORY_AUTHORED_SOURCES } from '@forge/contracts/memory';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import {
  anchorsMet,
  anchorsOf,
  flagKnowledgeForChange,
  type RecheckChange,
} from '../knowledge/index.js';
import { logger } from '../lib/logger.js';
import { endedByChange, endingAnchors } from './endings.js';
import { memoryIssueReads } from './ports.js';
import { recordUpkeep, upkeepRecorded } from './upkeep.js';

/**
 * Weigh the change against the project's live curated memories: one whose `endsWhen` the change meets
 * has ended and is retired (endings.ts); one whose `recheckWhen` it meets is flagged. How many were
 * flagged; the retired are logged.
 */
export async function flagMemoriesForChange(
  projectId: string,
  change: RecheckChange,
  at: string = new Date().toISOString(),
): Promise<number> {
  const rows = await db
    .select({ id: memories.id, metadata: memories.metadata })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        isNull(memories.archivedAt),
        inArray(memories.source, [...MEMORY_AUTHORED_SOURCES]),
        sql`(${memories.metadata}->'curation'->>'recheckWhen' IS NOT NULL OR ${memories.metadata}->'curation'->>'endsWhen' IS NOT NULL)`,
      ),
    );
  let flagged = 0;
  let ended = 0;
  for (const row of rows) {
    const curation = (row.metadata as Record<string, unknown>).curation as Record<string, unknown>;
    const ending = endingAnchors(typeof curation.endsWhen === 'string' ? curation.endsWhen : null);
    const endedOn = ending ? anchorsMet(ending, change) : [];
    if (endedOn.length > 0) {
      await db
        .update(memories)
        .set({
          archivedAt: sql`now()`,
          metadata: sql`${memories.metadata} || jsonb_build_object('archivedBy', ${endedByChange(change.by, endedOn)}::text)`,
        })
        .where(eq(memories.id, row.id));
      ended++;
      continue;
    }
    if (typeof curation.recheckWhen !== 'string') continue;
    const matched = anchorsMet(anchorsOf(curation.recheckWhen), change);
    if (matched.length === 0) continue;
    const flag = {
      staleSince: at,
      supersededBy: change.by,
      staleReason: `${change.by} changed what this memory says to re-check it on: ${matched.join(', ')}`,
    };
    await db
      .update(memories)
      .set({ metadata: sql`${memories.metadata} || ${JSON.stringify(flag)}::jsonb` })
      .where(eq(memories.id, row.id));
    flagged++;
  }
  if (ended > 0)
    logger.info(
      { projectId, by: change.by, ended },
      'memory.recheck: retired entries the change ended',
    );
  return flagged;
}

/**
 * A landing's re-check: what its commit changed and its own words, weighed against every curated
 * memory, knowledge entry and org rule of the project. A landing whose paths could not be read is
 * still weighed by its words, and the log says why the paths were not.
 */
export async function recheckForLanding(
  projectId: string,
  issueId: string,
): Promise<{ memories: number; knowledge: number } | null> {
  const landed = await memoryIssueReads().landedChange(projectId, issueId);
  if (!landed) return null;
  // once per landing: its close after awaiting_release does not flag again what an agent confirmed since
  const ref = `recheck:${landed.key}`;
  if (await upkeepRecorded(projectId, ref)) return null;
  if (landed.paths === null) {
    logger.info(
      { projectId, issueId, why: landed.why },
      'memory.recheck: the landing paths were not read; weighing its text alone',
    );
  }
  const change: RecheckChange = {
    by: landed.key,
    paths: landed.paths ?? [],
    text: landed.text,
    rules: [],
  };
  const flagged = {
    memories: await flagMemoriesForChange(projectId, change),
    knowledge: await flagKnowledgeForChange(projectId, change),
  };
  await recordUpkeep({
    projectId,
    kind: 'recheck',
    ref,
    text: `recheck ${landed.key}: ${flagged.memories} memor(ies) and ${flagged.knowledge} knowledge entr(ies) flagged over ${change.paths.length} path(s)`,
    metadata: {
      issueId,
      ...flagged,
      paths: change.paths.length,
      ...(landed.why ? { pathsUnread: landed.why } : {}),
    },
  });
  return flagged;
}

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface BrokenActivityChainLink {
  projectId: string;
  skillId: string;
  eventId: string;
  occurredAt: string;
  expectedBeforeHash: string;
  actualBeforeHash: string | null;
}

export interface SkillHashMismatch {
  projectId: string;
  skillId: string;
  loggedHash: string | null;
  currentHash: string;
}

const HASH_CHAIN_EVENT_TYPES = sql`('skill.body.changed')`;

/**
 * §7 self-check, part 1: for each (project, skill), every hash-mutating event
 * after the first must chain onto the previous event's after_hash. A gap means
 * a body change happened without going through this log — a bug, not data.
 */
export async function findBrokenActivityChains(): Promise<BrokenActivityChainLink[]> {
  const rows = await db.execute<{
    project_id: string;
    skill_id: string;
    event_id: string;
    occurred_at: string;
    before_hash: string | null;
    prev_after_hash: string | null;
  }>(sql`
    WITH chain AS (
      SELECT
        project_id,
        skill_id,
        id AS event_id,
        occurred_at,
        before_hash,
        LAG(after_hash) OVER (
          PARTITION BY project_id, skill_id ORDER BY occurred_at, id
        ) AS prev_after_hash,
        ROW_NUMBER() OVER (
          PARTITION BY project_id, skill_id ORDER BY occurred_at, id
        ) AS rn
      FROM skill_activity_events
      WHERE event_type IN ${HASH_CHAIN_EVENT_TYPES}
        AND project_id IS NOT NULL
        AND skill_id IS NOT NULL
    )
    SELECT project_id, skill_id, event_id, occurred_at, before_hash, prev_after_hash
    FROM chain
    WHERE rn > 1 AND prev_after_hash IS DISTINCT FROM before_hash
    ORDER BY project_id, skill_id, occurred_at
  `);

  return rows.map((r) => ({
    projectId: r.project_id,
    skillId: r.skill_id,
    eventId: r.event_id,
    occurredAt: r.occurred_at,
    expectedBeforeHash: r.prev_after_hash ?? '',
    actualBeforeHash: r.before_hash,
  }));
}

/**
 * §7 self-check, part 2: for each (project, skill), the last logged
 * after_hash must equal the skill row's current content_hash.
 */
export async function findSkillHashMismatches(): Promise<SkillHashMismatch[]> {
  const rows = await db.execute<{
    project_id: string;
    skill_id: string;
    logged_hash: string | null;
    current_hash: string;
  }>(sql`
    WITH last_event AS (
      SELECT DISTINCT ON (project_id, skill_id)
        project_id, skill_id, after_hash
      FROM skill_activity_events
      WHERE event_type IN ${HASH_CHAIN_EVENT_TYPES}
        AND project_id IS NOT NULL
        AND skill_id IS NOT NULL
      ORDER BY project_id, skill_id, occurred_at DESC, id DESC
    )
    SELECT le.project_id, le.skill_id, le.after_hash AS logged_hash, s.content_hash AS current_hash
    FROM last_event le
    JOIN skills s ON s.id = le.skill_id AND s.project_id = le.project_id
    WHERE le.after_hash IS DISTINCT FROM s.content_hash
  `);

  return rows.map((r) => ({
    projectId: r.project_id,
    skillId: r.skill_id,
    loggedHash: r.logged_hash,
    currentHash: r.current_hash,
  }));
}

export interface SkillActivityChainIntegrityReport {
  ok: boolean;
  brokenChains: BrokenActivityChainLink[];
  skillHashMismatches: SkillHashMismatch[];
}

/** Runs both §7 self-checks and reports whether the log is trustworthy. */
export async function checkSkillActivityChainIntegrity(): Promise<SkillActivityChainIntegrityReport> {
  const [brokenChains, skillHashMismatches] = await Promise.all([
    findBrokenActivityChains(),
    findSkillHashMismatches(),
  ]);
  return {
    ok: brokenChains.length === 0 && skillHashMismatches.length === 0,
    brokenChains,
    skillHashMismatches,
  };
}

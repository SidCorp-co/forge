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

export interface DeviceHashMismatch {
  deviceId: string;
  projectId: string;
  skillId: string;
  loggedHash: string | null;
  installedHash: string;
}

// cm:why single member now — 'body.reverted' was removed from the enum (no revert action emits it yet); kept as a tuple so a future revert event slots back in here.
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

/**
 * §7 self-check, part 3: for each device, the last-applied hash logged must
 * match `device_skills.installed_hash` — the runner's own observed state.
 */
export async function findDeviceHashMismatches(): Promise<DeviceHashMismatch[]> {
  const rows = await db.execute<{
    device_id: string;
    project_id: string;
    skill_id: string;
    logged_hash: string | null;
    installed_hash: string;
  }>(sql`
    WITH last_applied AS (
      SELECT DISTINCT ON (device_id, project_id, skill_id)
        device_id, project_id, skill_id, after_hash
      FROM skill_activity_events
      WHERE event_type = 'device.skill.applied'
        AND device_id IS NOT NULL
        AND project_id IS NOT NULL
        AND skill_id IS NOT NULL
      ORDER BY device_id, project_id, skill_id, occurred_at DESC, id DESC
    )
    SELECT
      la.device_id, la.project_id, la.skill_id,
      la.after_hash AS logged_hash, ds.installed_hash AS installed_hash
    FROM last_applied la
    JOIN device_skills ds
      ON ds.device_id = la.device_id
     AND ds.project_id = la.project_id
     AND ds.skill_id = la.skill_id
    WHERE la.after_hash IS DISTINCT FROM ds.installed_hash
  `);

  return rows.map((r) => ({
    deviceId: r.device_id,
    projectId: r.project_id,
    skillId: r.skill_id,
    loggedHash: r.logged_hash,
    installedHash: r.installed_hash,
  }));
}

export interface SkillActivityChainIntegrityReport {
  ok: boolean;
  brokenChains: BrokenActivityChainLink[];
  skillHashMismatches: SkillHashMismatch[];
  deviceHashMismatches: DeviceHashMismatch[];
}

/** Runs all three §7 self-checks and reports whether the log is trustworthy. */
export async function checkSkillActivityChainIntegrity(): Promise<SkillActivityChainIntegrityReport> {
  const [brokenChains, skillHashMismatches, deviceHashMismatches] = await Promise.all([
    findBrokenActivityChains(),
    findSkillHashMismatches(),
    findDeviceHashMismatches(),
  ]);
  return {
    ok:
      brokenChains.length === 0 &&
      skillHashMismatches.length === 0 &&
      deviceHashMismatches.length === 0,
    brokenChains,
    skillHashMismatches,
    deviceHashMismatches,
  };
}

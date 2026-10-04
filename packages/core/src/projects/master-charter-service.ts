import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectMasterCharters } from '../db/schema-master-charter.js';
import type { MasterCharterWrite } from './master-charter.js';
import { lockXact } from '../lib/advisory-lock.js';

export interface MasterCharter {
  version: number;
  goal: string;
  rules: string[];
  declaredBy: string;
  declaredAt: Date;
}

const asRules = (raw: unknown): string[] => (Array.isArray(raw) ? (raw as string[]) : []);

const projection = {
  version: projectMasterCharters.version,
  goal: projectMasterCharters.goal,
  rules: projectMasterCharters.rules,
  declaredBy: projectMasterCharters.declaredBy,
  declaredAt: projectMasterCharters.declaredAt,
};

function toCharter(row: {
  version: number;
  goal: string;
  rules: unknown;
  declaredBy: string;
  declaredAt: Date;
}): MasterCharter {
  return {
    version: row.version,
    goal: row.goal,
    rules: asRules(row.rules),
    declaredBy: row.declaredBy,
    declaredAt: row.declaredAt,
  };
}

/** The charter in force, or `null` where this project has declared none. */
export async function readCurrentCharter(projectId: string): Promise<MasterCharter | null> {
  const [row] = await db
    .select(projection)
    .from(projectMasterCharters)
    .where(eq(projectMasterCharters.projectId, projectId))
    .orderBy(desc(projectMasterCharters.version))
    .limit(1);
  return row ? toCharter(row) : null;
}

/** Every version this project was ever given, newest first — unbounded, because this history is
 *  a person's own hand-written record and not agent-volume data, so nothing here trims it. */
export async function readCharterVersions(projectId: string): Promise<MasterCharter[]> {
  const rows = await db
    .select(projection)
    .from(projectMasterCharters)
    .where(eq(projectMasterCharters.projectId, projectId))
    .orderBy(desc(projectMasterCharters.version));
  return rows.map(toCharter);
}

export interface DeclareCharterResult {
  charter: MasterCharter;
  /** False where the content had not moved, so no version was appended. */
  created: boolean;
}

const sameContent = (a: MasterCharter, b: MasterCharterWrite): boolean =>
  a.goal === b.goal &&
  a.rules.length === b.rules.length &&
  a.rules.every((rule, i) => rule === b.rules[i]);

/**
 * Append the next version of a project's charter, inside one transaction holding a per-project
 * advisory lock — `max(version) + 1` read outside one lets two writes land on the same number,
 * losing a person's declaration to a collision. A write whose content has not moved appends
 * nothing and reports that rather than staying silent about it.
 */
export async function declareCharter(input: {
  projectId: string;
  userId: string;
  write: MasterCharterWrite;
}): Promise<DeclareCharterResult> {
  return db.transaction(async (tx) => {
    await lockXact(tx, 'masterCharter', input.projectId);

    const [current] = await tx
      .select(projection)
      .from(projectMasterCharters)
      .where(eq(projectMasterCharters.projectId, input.projectId))
      .orderBy(desc(projectMasterCharters.version))
      .limit(1);

    if (current && sameContent(toCharter(current), input.write)) {
      return { charter: toCharter(current), created: false };
    }

    const [row] = await tx
      .insert(projectMasterCharters)
      .values({
        projectId: input.projectId,
        version: (current?.version ?? 0) + 1,
        goal: input.write.goal,
        rules: input.write.rules,
        declaredBy: input.userId,
      })
      .returning(projection);

    if (!row) throw new Error('master-charter: insert returned no row');
    return { charter: toCharter(row), created: true };
  });
}

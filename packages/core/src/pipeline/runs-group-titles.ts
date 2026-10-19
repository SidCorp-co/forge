import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { PipelineRunGroup } from './runs-lane.js';

/** A run as far as its group's titles go: its project and the issues it was opened over. */
interface RunWithGroup {
  projectId: string;
  group: PipelineRunGroup;
}

/** The title of every issue each run's group names, by project and key, in one read; no read where
 *  no run names a group. */
export async function loadGroupTitles(
  items: readonly RunWithGroup[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const named = items.filter((i) => i.group.issues.length > 0);
  if (named.length === 0) return out;
  const projectIds = [...new Set(named.map((i) => i.projectId))];
  const keys = [...new Set(named.flatMap((i) => i.group.issues))];
  const inProjects = sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const inKeys = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT project_id, 'ISS-' || iss_seq AS key, title -- ISS-992:canonical
      FROM issues
     WHERE project_id IN (${inProjects}) AND 'ISS-' || iss_seq IN (${inKeys}) -- ISS-992:canonical
  `)) as unknown as Array<{ project_id: string; key: string; title: string }>;
  for (const r of rows) {
    const titles = out.get(r.project_id) ?? {};
    titles[r.key] = r.title;
    out.set(r.project_id, titles);
  }
  return out;
}

/** The titles of `item`'s own group keys, out of its project's. */
export function groupTitlesOf(
  item: RunWithGroup,
  all: Map<string, Record<string, string>>,
): Record<string, string> {
  const titles = all.get(item.projectId) ?? {};
  return Object.fromEntries(
    item.group.issues.flatMap((key) => (titles[key] === undefined ? [] : [[key, titles[key]]])),
  );
}

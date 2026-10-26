/**
 * The fixture `issue-archive-e2e.test.ts` reads (ISS-1237): eight issues of one project with a
 * memory each, the edges between them, and the archive state each block of its cases starts from.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TestDb } from '../helpers/index.js';

const DIM = 1536;
export const TERM = 'staged pipeline clarify';

export function vectorFor(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  v[(seed * 7 + 3) % DIM] = 0.5;
  return v;
}
const vec = (seed: number) => `[${vectorFor(seed).join(',')}]`;

/** Each issue's id and its memory's id, by the key the cases name it with. */
export interface ArchiveGround {
  id: Record<string, string>;
  memoryId: Record<string, string>;
}

/** The fixture's edges: from, to, kind, and whether it has already expired. */
const EDGES: Array<[string, string, string, boolean]> = [
  ['open3', 'loadBearing', 'relates', false],
  ['pairA', 'pairB', 'blocks', false],
  ['open3', 'expired', 'blocks', true],
  ['neighbour', 'old', 'relates', false],
];

/** Archived by the cases that archive, and what every block after them starts from. */
export const ARCHIVED = ['old', 'pairA', 'pairB', 'expired'];

async function plantEdges(db: TestDb, projectId: string, id: Record<string, string>) {
  for (const [from, to, kind, expired] of EDGES) {
    const until = expired ? sql`now() - interval '1 day'` : sql`NULL`;
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (${projectId}, ${id[from]}, ${id[to]}, ${kind}, ${until})`);
  }
}

export async function plantArchiveGround(
  db: TestDb,
  projectId: string,
  adminId: string,
): Promise<ArchiveGround> {
  const ground: ArchiveGround = { id: {}, memoryId: {} };
  const seedIssue = async (
    seq: number,
    key: string,
    title: string,
    status: string,
    vecSeed: number,
  ) => {
    const issueId = randomUUID();
    const merged = status === 'closed' ? sql`now()` : sql`NULL`;
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, description, status, created_by_id, merged_at, created_at)
      VALUES (${issueId}, ${projectId}, ${seq}, ${title}, ${`body of ${title}`}, ${status}, ${adminId},
              ${merged}, now() + ${`${seq} seconds`}::interval)`);
    const rows = (await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
      VALUES (${projectId}, 'issue', ${issueId}, ${title}, ${vec(vecSeed)}::vector) RETURNING id`)) as unknown as {
      id: string;
    }[];
    ground.id[key] = issueId;
    ground.memoryId[key] = rows[0]?.id ?? '';
  };

  await seedIssue(1, 'old', `Legacy ${TERM} step`, 'closed', 1);
  await seedIssue(2, 'control', `Current ${TERM} replacement`, 'closed', 2);
  await seedIssue(3, 'open3', 'Planned rewrite of the clarify handoff', 'open', 3);
  await seedIssue(4, 'loadBearing', 'Closed but related to open work', 'closed', 4);
  await seedIssue(5, 'pairA', 'Closed pair A', 'closed', 5);
  await seedIssue(6, 'pairB', 'Closed pair B', 'dropped', 6);
  await seedIssue(7, 'expired', 'Closed with an expired edge', 'closed', 7);
  await seedIssue(8, 'neighbour', 'Closed neighbour of the legacy one', 'closed', 8);
  await plantEdges(db, projectId, ground.id);
  await db.execute(sql`
    UPDATE memories SET chunked_at = now(), chunk_generation = 1 WHERE id = ${ground.memoryId.old}`);
  await db.execute(sql`
    INSERT INTO memory_chunks (memory_id, chunk_index, text_content, context_prefix, embedding, generation)
    VALUES (${ground.memoryId.old}, 0, ${`Legacy ${TERM} step`}, 'ISS-1', ${vec(1)}::vector, 1)`);
  return ground;
}

/**
 * Stand the fixture where a block of cases starts from: `archived` archived and every other issue
 * not, and the fixture's edges as planted, whatever a case before it archived, unarchived or
 * retracted. Each block names its own starting point, so no case reads what another left.
 */
export async function standAt(
  db: TestDb,
  projectId: string,
  id: Record<string, string>,
  archived: string[],
) {
  await db.execute(sql`UPDATE issues SET archived_at = NULL WHERE project_id = ${projectId}`);
  for (const key of archived) {
    await db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${id[key]}`);
  }
  await db.execute(sql`DELETE FROM issue_dependencies WHERE project_id = ${projectId}`);
  await plantEdges(db, projectId, id);
}

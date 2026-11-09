// Who stands in forge-dev's projects beside the person reading (ISS-1070 r21): each project's own
// agent account as an admin, a QA account and a steward on some, and feedback filed by every
// project's agent into the others, as forge-dev's is (forge's 500 items name 25 reporters). The plain
// seed held one agent no project counted as a member, so every name a read asked was the reader's or
// that one agent's, read once early: forge-dev's reads asked each project's holders and reporters a
// wave later, and sent their names again (`lib/people.ts:peopleOf`, cb834152 ×2 to ×4 an area).

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { uuidArray } from '../../src/db/raw-sql.js';
import { addProjectMember, createTestUser } from './factories.js';

/** Agents of projects outside the person's that file feedback into them: forge's name six such. */
const OUTSIDE = 6;

/**
 * Gives each of `projectIds` its own agent account as an admin and a QA person as a member on one
 * project in three, a steward agent as a viewer on forge (the first); the agent files most of its
 * project's issues, and the feedback items an agent filed are spread over every project's agent and
 * {@link OUTSIDE} agents of projects the person does not read.
 */
export async function peopleAsLive(projectIds: readonly string[]): Promise<void> {
  const agents: string[] = [];
  const qa = (await createTestUser({ verified: true })).id;
  for (const [i, id] of projectIds.entries()) {
    const agent = (await createTestUser({ kind: 'agent' })).id;
    agents.push(agent);
    await addProjectMember(id, agent, 'admin');
    if (i % 3 === 0) await addProjectMember(id, qa, 'member');
    // an agent filed most of it: the person owns one issue in seven
    await db.execute(
      sql`UPDATE issues SET created_by_id = ${agent} WHERE project_id = ${id} AND iss_seq % 7 <> 0`,
    );
  }
  const steward = (await createTestUser({ kind: 'agent' })).id;
  if (projectIds[0]) await addProjectMember(projectIds[0], steward, 'viewer');
  // each project's agent files into the others, and so do agents of projects the person does not
  // read (a channel agent, a site visitor): one item in five is the person's own
  const reporters = [...agents];
  for (let n = 0; n < OUTSIDE; n++) reporters.push((await createTestUser({ kind: 'agent' })).id);
  await db.execute(sql`
    UPDATE feedback f
       SET reported_by = (${uuidArray(reporters)})[1 + (f.fb_seq % ${reporters.length})]
     WHERE f.project_id = ANY(${uuidArray(projectIds)}) AND f.fb_seq % 5 <> 0`);
}

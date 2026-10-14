/**
 * The ground the design-issue suites stand on (`design-issue-e2e`, `design-approval-after-e2e`): an
 * owner, a project landing through git and one outside it, a master holding a token for both, and the
 * reads and writes every case takes of a design and of the issue drawing it (ISS-261, ISS-262, ISS-263).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from './ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from './factories.js';
import { seedProjectDocument } from './release-world.js';

let ownerId: string;
export let gitProject: string;
export let outsideProject: string;
export let say: (
  who: 'owner' | 'master',
  method: string,
  path: string,
  body?: unknown,
) => Promise<Reply>;
export let designLandingOf: typeof import('../../src/issues/design-landing.js').designLandingOf;
export let mergeNotRecorded: typeof import('../../src/issues/merged-at.js').mergeNotRecorded;

const design = (): Doc =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );

/** Registers the suite's world: an owner, a project landing through git and one outside it, and a master. */
export function designIssueWorld(): void {
  beforeAll(async () => {
    testEnv();
    const { app } = await import('../../src/index.js');
    await startQueue();
    const { signUserToken } = await import('../../src/credentials/jwt.js');
    const { mintPat } = await import('../../src/credentials/pat.js');
    ({ designLandingOf } = await import('../../src/issues/design-landing.js'));
    ({ mergeNotRecorded } = await import('../../src/issues/merged-at.js'));
    ownerId = (await createTestUser({ verified: true })).id;
    gitProject = (await createTestProject(ownerId)).id;
    outsideProject = (await createTestProject(ownerId)).id;
    await seedProjectDocument(gitProject, ownerId, { environments: {} });
    await seedProjectDocument(outsideProject, ownerId, {
      environments: {},
      source: { type: 'none' },
    });
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(gitProject, agent, 'member');
    await addProjectMember(outsideProject, agent, 'member');
    say = requester(app, {
      owner: await signUserToken(ownerId),
      master: (
        await mintPat({
          permissions: ['*'],
          userId: agent,
          name: 'master',
          projectIds: [gitProject, outsideProject],
        })
      ).plaintext,
    });
  }, 120_000);

  afterAll(async () => {
    await closeWorld();
  });
}

export const at = (project: string, path: string) => `/api/projects/${project}${path}`;
export const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

export interface Mark {
  mergedAt?: Date | null;
  sha?: string | null;
  landing?: string | null;
}

let seq = 500;
/** An issue planted at a status and mark under the kernel's flag: the subject is what a design write or decision does to it. */
export async function plantIssue(project: string, status: string, mark: Mark = {}) {
  const id = randomUUID();
  seq += 1;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                          merged_at, merged_commit_sha, merged_landing)
      VALUES (${id}, ${project}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId},
              ${mark.mergedAt?.toISOString() ?? null}::timestamptz, ${mark.sha ?? null},
              ${mark.landing ?? null})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

export async function markOf(issueId: string) {
  const [row] = await rows<{
    status: string;
    merged_at: string | null;
    merged_commit_sha: string | null;
    merged_landing: string | null;
    merged_artifacts: unknown;
  }>(
    sql`SELECT status, merged_at, merged_commit_sha, merged_landing, merged_artifacts FROM issues WHERE id = ${issueId}`,
  );
  return row && { ...row, merged_at: row.merged_at === null ? null : new Date(row.merged_at) };
}

export async function proposedDesign(
  project: string,
  flow: string,
  issue?: string,
): Promise<string> {
  const d = design();
  d.project = project;
  d.flow = flow;
  const made = ok(
    await say('master', 'POST', at(project, '/workflows'), { baseRevision: null, document: d }),
    201,
  );
  const id = made.document.id as string;
  ok(
    await say('master', 'POST', at(project, `/workflows/${id}/design/propose`), {
      revision: 1,
      ...(issue ? { issue } : {}),
    }),
  );
  return id;
}

/** A PUT that changes the design, so it proposes a new revision; `issue` names the drawing issue. */
export async function writeChanged(project: string, id: string, issue?: string): Promise<Reply> {
  const read = ok(await say('master', 'GET', at(project, `/workflows/${id}`)));
  const document = { ...read.document, summary: `${read.document.summary} (rev ${read.revision})` };
  return say('master', 'PUT', at(project, `/workflows/${id}`), {
    baseRevision: read.revision,
    document,
    ...(issue ? { issue } : {}),
  });
}

export const decide = (
  project: string,
  id: string,
  revision: number,
  decision: string,
  reason?: string,
) =>
  say('owner', 'POST', at(project, `/workflows/${id}/design/decision`), {
    revision,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });

export const designOf = async (project: string, id: string) =>
  ok(await say('master', 'GET', at(project, `/workflows/${id}/design`)));

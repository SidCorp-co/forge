// A person's declaration of a review run (`review-run-routes.ts`), as project-config reads and refuses
// it: the caller is a person, the profile is one the project declares, and the run is opened on the
// box by the devices kernel (`devices/review-run.ts`), which refuses the issue and the box by name.

import {
  REVIEW_RUN_DEFAULT_MINUTES,
  type ReviewRunDeclaration,
} from '@forge/contracts/agent-sessions';
import type { ProjectConfigRefusalCode } from '@forge/contracts/project-config';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, users } from '../db/schema.js';
import { RefusalError } from '../lib/refusal.js';
import { projectConfigPorts } from './ports.js';
import { readTestingProfile } from './service.js';

const refuse = (code: ProjectConfigRefusalCode, detail: string, path = '') =>
  new RefusalError([{ code, path, detail }], code);

/** Declare a review run for `userId`, who the route has checked holds project admin. */
export async function declareReviewRun(args: {
  projectId: string;
  userId: string;
  issue: string;
  box: string;
  profile: string;
  minutes?: number;
}) {
  const { projectId, userId, profile } = args;
  const [caller] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (caller?.kind !== 'human') {
    throw refuse(
      'REVIEW_RUN_NOT_A_PERSON',
      `account ${userId} is an agent, and a review run is declared by a person for a session working for them; an agent's runs are declared by its project's master (\`forge-runner run declare\`).`,
    );
  }
  if (!(await readTestingProfile(projectId, profile))) {
    throw refuse(
      'REVIEW_RUN_PROFILE_UNKNOWN',
      `project ${projectId} declares no testing profile \`${profile}\`; GET /api/projects/${projectId}/testing-profiles lists the ones it does.`,
      '/profile',
    );
  }
  const minutes = args.minutes ?? REVIEW_RUN_DEFAULT_MINUTES;
  const declaration: ReviewRunDeclaration = {
    declaredBy: userId,
    profile,
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  const run = await projectConfigPorts().openReviewRun({
    projectId,
    box: args.box,
    issue: args.issue,
    declaration,
  });
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const read = `forge-runner api jobs/${run.runId}/testing-profiles/${profile}/secrets`;
  const close = `forge-runner api -X POST devices/me/run-sessions/${run.sessionId}/close -f outcome=ended`;
  const borrow = `FORGE_BORROW_FROM=<the runner's config dir>/forge-runner/master/${project?.slug ?? '<project slug>'}/forge-cli.json`;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    projectId,
    issue: run.issue,
    box: run.box,
    ...declaration,
    read,
    close,
    says: `Run ${run.runId} reviews ${run.issue} on box ${run.box.name} and reads testing profile \`${profile}\` until ${declaration.expiresAt}. Read it under the box's credential, from a shell on ${run.box.name}: \`${borrow} ${read}\`; every read is audited on ${run.issue}. Close it under the same credential with \`${borrow} ${close}\`; left open, it ends at ${declaration.expiresAt}.`,
  };
}

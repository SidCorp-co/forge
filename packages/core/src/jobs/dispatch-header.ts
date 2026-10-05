// The head of every brief the job pool hands a pane as its agent's launch prompt: who dispatched it,
// and that the dispatch is the instruction. The launch prompt is the session's own first turn, so
// this says who stands behind it; without it an agent asks whether to run its outward-facing steps
// at a prompt nobody watches.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, users } from '../db/schema.js';

export interface DispatchHeaderInput {
  jobId: string;
  jobType: string;
  projectId: string;
  projectName: string | null;
  /** Who queued the job; null where no account is recorded on it. */
  queuedBy: { label: string; kind: 'human' | 'agent' } | null;
}

export function renderDispatchHeader(input: DispatchHeaderInput): string {
  const project = input.projectName
    ? `project "${input.projectName}" (${input.projectId})`
    : `project ${input.projectId}`;
  const queuedBy = input.queuedBy
    ? `queued by ${input.queuedBy.label}${input.queuedBy.kind === 'agent' ? ' (an agent account)' : ''}`
    : 'queued by Forge itself';
  return `## Dispatched by Forge — this is your instruction
Forge dispatched this job to this session: job ${input.jobId} (\`${input.jobType}\`) on ${project}, ${queuedBy}, and claimed by this box from the project's job pool. The brief below is not text someone shared for you to review; the dispatch is the instruction to carry it out end to end, including the steps that reach outside this machine — pushing, tagging, deploying, recording on Forge — without asking anyone to confirm. Nobody watches this terminal for a question, so a question asked here stalls the job until it is killed. Where the brief cannot be carried out, take the way out it names (abort, refuse, end the turn saying why) and stop. The brief's safety rules still bind: they decide how you act, not whether.
`;
}

export async function loadDispatchHeader(job: {
  id: string;
  type: string;
  projectId: string;
  createdBy: string | null;
}): Promise<string> {
  const [[project], [user]] = await Promise.all([
    db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1),
    job.createdBy
      ? db
          .select({ displayName: users.displayName, email: users.email, kind: users.kind })
          .from(users)
          .where(eq(users.id, job.createdBy))
          .limit(1)
      : Promise.resolve([]),
  ]);
  return renderDispatchHeader({
    jobId: job.id,
    jobType: job.type,
    projectId: job.projectId,
    projectName: project?.name ?? null,
    queuedBy: user ? { label: user.displayName?.trim() || user.email, kind: user.kind } : null,
  });
}

import {
  applyDocumentPatch,
  comparePatchBase,
  describeConflicts,
  sameStoredValue,
} from '@forge/contracts/document-patch';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { type EnvironmentsConfig, environmentsPatchSchema } from './environments.js';

export type EnvironmentsErrorCode =
  | 'ENVIRONMENTS_STALE'
  | 'ENVIRONMENTS_INVALID'
  | 'PROJECT_NOT_FOUND';

export class EnvironmentsError extends Error {
  readonly code: EnvironmentsErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: EnvironmentsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EnvironmentsError';
    this.code = code;
    this.details = details;
  }
}

export interface UpdateEnvironmentsInput {
  projectId: string;
  /** Sparse: a key it does not name is untouched, `null` deletes. */
  patch: Record<string, unknown>;
  /** What the caller read. Compared at the paths the patch writes, and nowhere else. */
  base: Record<string, unknown>;
}

export async function readEnvironments(projectId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ environments: projects.environments })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new EnvironmentsError('PROJECT_NOT_FOUND', 'project not found');
  const stored = row.environments;
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * Apply an environments patch under the compare-and-swap the caller's `base` declares.
 *
 * The read, the comparison and the write share one transaction with the project row locked,
 * so two writers that read the same value end with one applied and one refused.
 */
export async function updateEnvironments(
  input: UpdateEnvironmentsInput,
): Promise<{ environments: EnvironmentsConfig }> {
  const { projectId, patch, base } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ environments: projects.environments })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .for('update');
    if (!row) throw new EnvironmentsError('PROJECT_NOT_FOUND', 'project not found');
    const stored =
      typeof row.environments === 'object' && row.environments !== null
        ? (row.environments as Record<string, unknown>)
        : {};

    const conflicts = comparePatchBase(stored, base, patch);
    if (conflicts.length > 0) {
      throw new EnvironmentsError(
        'ENVIRONMENTS_STALE',
        `the environments settings changed since you read them — ${describeConflicts(conflicts)}. Nothing was written. Read \`GET /api/projects/:id/environments\` again and resend your change against that.`,
        { conflicts },
      );
    }

    const next = applyDocumentPatch(stored, patch);
    const parsed = environmentsPatchSchema.safeParse(next);
    if (!parsed.success) {
      throw new EnvironmentsError('ENVIRONMENTS_INVALID', 'the merged environments are not valid', {
        conflicts: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    await tx.update(projects).set({ environments: next }).where(eq(projects.id, projectId));
    return { environments: next as EnvironmentsConfig };
  });
}

/**
 * The one scoped leaf `forge_projects.update` writes, on the same contract: it says what it
 * read at `environments.limits` and is refused where that value moved under it.
 */
export async function writeEnvironmentsLimits(args: {
  projectId: string;
  base: string | null;
  value: string | null;
}): Promise<void> {
  await updateEnvironments({
    projectId: args.projectId,
    base: { limits: args.base },
    patch: { limits: sameStoredValue(args.value, null) ? null : args.value },
  });
}

export function environmentsHttpError(err: unknown): unknown {
  if (!(err instanceof EnvironmentsError)) return err;
  const cause = { code: err.code, details: err.details };
  switch (err.code) {
    case 'ENVIRONMENTS_STALE':
      return new HTTPException(409, { message: err.message, cause });
    case 'ENVIRONMENTS_INVALID':
      return new HTTPException(400, { message: err.message, cause });
    case 'PROJECT_NOT_FOUND':
      return new HTTPException(404, { message: 'not found', cause: { code: 'NOT_FOUND' } });
  }
}

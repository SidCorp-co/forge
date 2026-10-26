import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const REPO_PATH_NOT_ABSOLUTE = 'REPO_PATH_NOT_ABSOLUTE';

/** Rooted on a POSIX device, a Windows drive or a share; a relative one is refused (ISS-1229 r25). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

export function repoPathRefusal(path: string): string {
  return `The repository path "${path}" is not an absolute path. Give the checkout's full path from the root of its device, such as /home/forge/projects/app or C:\\projects\\app, or leave it empty.`;
}

/** The repository path field: an absolute path, empty, or null for none. */
export const repoPathField = z
  .string()
  .trim()
  .max(500)
  .refine((path) => path === '' || isAbsolutePath(path), {
    error: (issue) => repoPathRefusal(String(issue.input)),
  });

/**
 * The refusal's sentence for the field at `at` (`patch.repoPath` in an MCP tool), matched whole:
 * `agentConfig.repoPath` is a retired key with its own sentence.
 */
export function repoPathRefusalIn(
  error: { issues: readonly z.core.$ZodIssue[] },
  at: readonly PropertyKey[] = ['repoPath'],
): string | null {
  const issue = error.issues.find(
    (i) =>
      i.code === 'custom' && i.path.length === at.length && i.path.every((p, n) => p === at[n]),
  );
  return issue ? issue.message : null;
}

/** The refusal for a body whose repository path is not absolute, or null where that is not what failed. */
export function refusedRepoPath(error: {
  issues: readonly z.core.$ZodIssue[];
}): HTTPException | null {
  const message = repoPathRefusalIn(error);
  if (message === null) return null;
  return new HTTPException(400, {
    message,
    cause: { code: REPO_PATH_NOT_ABSOLUTE, details: { field: 'repoPath' } },
  });
}

/** An MCP tool's input, parsed, with a relative repository path refused by name as REST refuses it. */
export function parseRefusingRelativeRepoPath<T>(
  schema: z.ZodType<T>,
  args: unknown,
  at: readonly PropertyKey[] = ['repoPath'],
): T {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const message = repoPathRefusalIn(parsed.error, at);
  if (message !== null) throw new Error(`BAD_REQUEST: ${REPO_PATH_NOT_ABSOLUTE}: ${message}`);
  throw parsed.error;
}

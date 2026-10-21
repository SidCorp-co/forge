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

/** The refusal for a body whose repository path is not absolute, or null where that is not what failed. */
export function refusedRepoPath(error: {
  issues: readonly z.core.$ZodIssue[];
}): HTTPException | null {
  const issue = error.issues.find((i) => i.path[0] === 'repoPath' && i.code === 'custom');
  if (!issue) return null;
  return new HTTPException(400, {
    message: issue.message,
    cause: { code: REPO_PATH_NOT_ABSOLUTE, details: { field: 'repoPath' } },
  });
}

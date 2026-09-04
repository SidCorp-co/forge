// ISS-137 — Issue.metadata validation (Layer 2 branch config override).
//
// Lives in its own module so unit tests can exercise the schemas without
// loading routes.ts → db/client.ts (which pulls in env validation).

import { z } from 'zod';

// Empty strings rejected so callers must pass `null` to clear a single field.
// Regex matches Git's safe-ish ref subset (no spaces, no shell-special chars).
const BRANCH_NAME_RE = /^[a-zA-Z0-9._/-]{1,100}$/;

export const branchNameSchema = z
  .string()
  .trim()
  .min(1, 'branch name must not be empty')
  .max(100)
  .regex(BRANCH_NAME_RE, 'invalid branch name');

export const branchConfigOverrideSchema = z
  .object({
    baseBranch: branchNameSchema.nullable().optional(),
    targetBranch: branchNameSchema.nullable().optional(),
    prodBranch: branchNameSchema.nullable().optional(),
  })
  .strict();

export const issueMetadataSchema = z
  .object({
    branchConfig: branchConfigOverrideSchema.nullable().optional(),
  })
  .strict()
  .nullable();

// forge-code creates branches like `iss-<seq>-<slug>`; matching the exact
// `iss-<seq>` or the `iss-<seq>-` prefix would create a fetch-from-self loop.
export function isSelfReferentialBranch(branch: string, issSeq: number): boolean {
  const normalized = branch.trim().toLowerCase();
  const selfPrefix = `iss-${issSeq}`;
  return normalized === selfPrefix || normalized.startsWith(`${selfPrefix}-`);
}

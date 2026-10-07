// The policy and testing-profile documents a project declares beside its project document.

import { REASON_LINE_MAX } from '@forge/contracts/comments';
import {
  AUTONOMOUS_DRIVER_STATUSES,
  ISSUE_TERMINAL_STATUSES,
} from '@forge/contracts/issue-machine';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { z } from 'zod';
import type { IssueStatus } from '../db/schema.js';
import { SHORT_NAME, sized, slug, unique } from './schema.js';

// The driver statuses minus the terminal ones, not every status: nothing dispatches at
// `awaiting_release` or past it.
export const POLICY_STATE_STATUSES: readonly IssueStatus[] = AUTONOMOUS_DRIVER_STATUSES.filter(
  (s) => !ISSUE_TERMINAL_STATUSES.includes(s),
);

function nonEmpty<T>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  // an empty list would emit a states object no policy can satisfy; refuse to load.
  if (first === undefined) {
    throw new Error(
      'project-config/policy-schema.ts: POLICY_STATE_STATUSES derived empty from AUTONOMOUS_DRIVER_STATUSES; a policy needs at least one dispatchable status.',
    );
  }
  return [first, ...rest];
}

const profileName = () => z.string().regex(SHORT_NAME);

// contract -> packages/runner/crates/runner-workspace/src/terminal.rs:job_argv — the grammar of
// one `--disallowed-tools` entry a job pane is started with: a built-in tool, optionally with a
// specifier (`Bash(git push:*)`), or an MCP server or tool (`mcp__forge__forge_coolify_deploy`, `mcp__x__*`).
export const TOOL_PATTERN =
  /^(?:[A-Z][A-Za-z0-9]*(?:\((?! )[^()\n]{1,200}(?<! )\))?|mcp__[A-Za-z0-9-][A-Za-z0-9_-]*(?<!_)(?:__\*)?)$/;

export const policyDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/policy-v1.json`),
  version: z.literal(1),
  qa: z.enum(['self', 'independent']),
  intake: z.strictObject({ mode: z.enum(['auto', 'manual']) }),
  permissions: sized(
    z.record(
      profileName(),
      z.strictObject({
        deny: unique(z.array(z.string().max(220).regex(TOOL_PATTERN)).max(100)),
      }),
    ),
    { min: 1, max: 10 },
  ),
  states: sized(
    z.partialRecord(
      z.enum(nonEmpty(POLICY_STATE_STATUSES)),
      z.strictObject({
        model: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
        permissions: profileName(),
      }),
    ),
    { min: 1 },
  ),
});

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

const secretRef = () => z.string().regex(/^secret:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/);

export const testingProfileSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/testing-profile-v1.json`),
  version: z.literal(1),
  id: slug(),
  actors: sized(
    z.record(
      z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
      z.strictObject({
        role: z.enum([
          'deployment-admin',
          'org-owner',
          'org-admin',
          'org-member',
          'project-admin',
          'project-member',
          'viewer',
        ]),
        credential: secretRef(),
        scope: unique(z.array(slug())).optional(),
      }),
    ),
    { max: 20 },
  ),
  services: sized(
    z.record(
      z.string().regex(SHORT_NAME),
      z.strictObject({
        access: z.enum(['readonly', 'readwrite']),
        credential: secretRef(),
        endpoint: z.string().min(1).max(300).optional(),
      }),
    ),
    { max: 20 },
  ),
  limits: unique(
    z.array(z.strictObject({ id: slug(), note: z.string().min(1).max(REASON_LINE_MAX) })).max(30),
  ),
});

export type TestingProfile = z.infer<typeof testingProfileSchema>;

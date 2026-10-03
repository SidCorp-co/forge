import { z } from 'zod';
import { type IssueStatus, issueStatuses } from '../../db/schema.js';
import { isLegacyStatus, legacyRefusal } from '../../issues/legacy-status.js';

/** The ten statuses; a retired one is refused by name with what it became (ISS-54). */
export const issueStatusInput = z
  .string()
  .superRefine((value, ctx) => {
    if (isLegacyStatus(value)) {
      ctx.addIssue({ code: 'custom', message: legacyRefusal(value) });
    } else if (!(issueStatuses as readonly string[]).includes(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `\`${value}\` is not an issue status; the statuses are ${issueStatuses.join(', ')}`,
      });
    }
  })
  // A cast, not `.transform`: MCP publishes this as JSON Schema, which cannot hold a transform.
  .describe(`One of: ${issueStatuses.join(', ')}.`) as unknown as z.ZodType<IssueStatus>;

export const WORK_STATE_FIELD =
  'Where the work stands inside its status (ISS-54): `step` (triage, clarify, plan, build, test, release; null ends it), `branch`, `headSha` (full 40-hex). Written by the run that holds the issue; the status says who it waits on, the step says how far the run is.';

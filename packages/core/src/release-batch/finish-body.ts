// The body `POST /api/projects/:projectId/release-batches/:runId/finish` takes, beside the release
// brief that names its keys (`prompt.ts`): one source for both, so the brief never asks a run to say
// something in a place no door takes (ISS-1334, FB-744: told to say it "in what you record", the run
// sent `summary`, was refused, and wrote its account as a comment on each roster issue).

import { z } from 'zod';

/** One production site a record names shipped, with what its own runtime verification read it serving (ISS-1077). */
const siteRecordSchema = z
  .object({
    name: z.string().trim().min(1).max(63),
    serves: z.string().trim().min(1).max(200),
  })
  .strict();
export const sitesSchema = z.array(siteRecordSchema).min(1).max(10);

/** The key of a finish that carries the run's own account of the release, which its page shows. */
export const FINISH_ACCOUNT_KEY = 'note';

/** The longest account a finish takes: the run's prose, as long as a release record's account. */
const ACCOUNT_MAX = 20_000;

export const finishBodySchema = z
  .object({
    commit: z.string().trim().max(200).optional(),
    sites: sitesSchema.optional(),
    /** The run's account of the release in its own words; the release page shows it (ISS-1334). */
    [FINISH_ACCOUNT_KEY]: z.string().trim().min(1).max(ACCOUNT_MAX).optional(),
  })
  .strict();

/** What a finish carrying a key it does not take is told: the keys it takes, and where prose goes. */
export const FINISH_BODY_HINT = `finish takes \`commit\` (the sha you pushed), \`sites\` (each production site with what it serves) and \`${FINISH_ACCOUNT_KEY}\`: your account of the release in your own words (the tag you pushed, what you read, whether the release-runner preference was honoured), which the release page shows. Any other prose goes in \`${FINISH_ACCOUNT_KEY}\`, never in another key and never as comments on the roster's issues`;

import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { MessageRefusal } from '../messaging/contract.js';
import type { ForgeRecord } from '../messaging/forge-record.js';

/** The rule this module owns, named on every refusal it produces. */
export const LOCAL_PREVIEW_SKIP_RULE = 'skip-reason-local-preview';

/**
 * The claims a `why` makes when what is absent is a DEPLOYMENT of the change itself.
 *
 * This is a matcher over a stated reason, so its bounds are fixtures rather than theory, and
 * `skip-reason.test.ts` holds both halves: the real `why` lines ISS-1152 c12, c13 and c14 carry,
 * which a local preview answers, and the real lines ISS-1114 c13, ISS-1118 and ISS-1139 c16 carry,
 * which it does not — those name a separately installed runner binary or a box refusing work, and
 * standing the product up locally reaches none of them. A probe that swallowed the second set
 * would make a run claim a route it has not got, which is worse than the skip.
 */
const NO_DEPLOYMENT_CLAIMS: readonly RegExp[] = [
  /\bno deployments?\b/u,
  /\bnot (?:running|deployed) anywhere\b/u,
  /\brunning product predates\b/u,
  /\bnothing (?:is|has been) deployed\b/u,
  /\bno deployed (?:preview|environment|build|version)\b/u,
];

/** Whether this reason says the change is in no deployment at all. */
export function namesNoDeployment(why: string): boolean {
  const text = why.toLowerCase().replace(/\s+/gu, ' ');
  return NO_DEPLOYMENT_CLAIMS.some((probe) => probe.test(text));
}

/**
 * The criteria this record skips for want of a deployment, in the order written.
 *
 * `criterion` opens a block and `why` closes the reason inside it, which is the layout
 * `forge record verdict` writes and the one `criteria-verdicts.ts` already reads pairs out of.
 */
export function criteriaSkippedForNoDeployment(record: ForgeRecord | null): number[] {
  if (record?.kind !== 'verdict') return [];
  const out: number[] = [];
  let criterion: number | null = null;
  let skipped = false;
  for (const field of record.fields) {
    if (field.key === 'criterion') {
      const n = Number.parseInt(field.value, 10);
      criterion = Number.isFinite(n) ? n : null;
      skipped = false;
      continue;
    }
    if (field.key === 'verdict') {
      skipped = field.value.trim() === 'skipped';
      continue;
    }
    if (field.key === 'why' && skipped && criterion !== null && namesNoDeployment(field.value)) {
      out.push(criterion);
      skipped = false;
    }
  }
  return out;
}

const SHAPE =
  'on a project whose preview is local, a criterion is exercised on the box the run is already standing on, not skipped for want of a deployment';

/** The refusal, naming the criteria it refused and the route this project actually has. */
export function localPreviewSkipRefusal(criteria: readonly number[]): MessageRefusal {
  const named =
    criteria.length === 1 ? `criterion ${criteria[0]}` : `criteria ${criteria.join(', ')}`;
  return {
    rule: LOCAL_PREVIEW_SKIP_RULE,
    why: `${named} is skipped for want of a deployment, and this project declares \`previewShape: "local"\` — it has no deployed preview and is not waiting to get one. LOCAL IS THE PREVIEW here: stand the product up in this run's own worktree at the commit being judged and exercise the criterion there. A criterion out of reach for some OTHER reason — a credential nobody minted, a separately installed binary, a box that refuses work — is skipped with THAT reason and stands; this refusal is about the one reason this project's shape already answers.`,
    quote: 'verdict: skipped',
    shape: SHAPE,
    example: "why: exercised against the product stood up locally at <sha>, in this run's worktree",
  };
}

/**
 * What this record is refused for on account of the project's declared shape.
 *
 * Read fails open: a comment is not lost because one column could not be read, and the read is
 * logged so a silence here is visible rather than inferred.
 */
export async function verdictShapeRefusals(
  projectId: string,
  record: ForgeRecord | null,
  executor?: Tx,
): Promise<MessageRefusal[]> {
  const criteria = criteriaSkippedForNoDeployment(record);
  if (criteria.length === 0) return [];
  const handle = executor ?? db;
  try {
    const [row] = await handle
      .select({ previewShape: projects.previewShape })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (row?.previewShape !== 'local') return [];
  } catch (err) {
    logger.warn(
      { err, projectId },
      'skip-reason: could not read the declared preview shape — the verdict is not screened for it',
    );
    return [];
  }
  return [localPreviewSkipRefusal(criteria)];
}

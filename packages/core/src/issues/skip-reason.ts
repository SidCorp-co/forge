import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { MessageRefusal } from '../messaging/contract.js';
import type { ForgeRecord } from '../messaging/forge-record.js';

export const LOCAL_PREVIEW_SKIP_RULE = 'skip-reason-local-preview';

/** A resource right after `no deployment` makes the sentence about it, not about a deployment. */
const RESOURCE = /(?!\s+(?:credential|secret|key|token|account|access|permission|log|url)\w*)/
  .source;

/**
 * The claims a `why` makes when what is absent is a DEPLOYMENT OF THE CHANGE. A matcher over stated
 * prose, bounded both ways by the real lines in `skip-reason.test.ts`: ISS-1152 c12/c13/c14, which
 * a local preview answers, against ISS-1114 c13, ISS-1118 and ISS-1139 c16, which it does not.
 */
const NO_DEPLOYMENT_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `\\bno deployments?\\b${RESOURCE}\\s+(?:\\w+\\s+){0,3}?(?:contain\\w*|carr\\w+|hold\\w*|serv\\w+|includ\\w+|dispatch\\w*|exercis\\w+|exists?)\\b`,
    'u',
  ),
  /\bno deployments? of (?:this|the) change\b/u,
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

/** The criteria this record skips for want of a deployment, in the order written. `criterion`
 *  opens a block and `why` closes the reason inside it — the layout `forge record verdict` writes
 *  and `criteria-verdicts.ts` reads pairs out of. */
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
    why: `${named} is skipped for want of a deployment, and this project declares \`previewShape: "local"\` — it has no deployed preview and is not waiting to get one. LOCAL IS THE PREVIEW here: stand the product up in this run's own worktree at the commit being judged and exercise the criterion there, citing that commit and the artefact of the exercise. A criterion out of reach for some OTHER reason — a credential nobody minted, a separately installed binary, a box that refuses work — is skipped with THAT reason and stands.`,
    quote: 'verdict: skipped',
    shape: SHAPE,
    example: "why: exercised against the product stood up locally at <sha>, in this run's worktree",
  };
}

/** Whether this project's declaration puts a verdict under this rule. `kind` sits beside the shape
 *  because the preview axis splits `standard` and says nothing about `website`. */
export function shapeScreensVerdicts(row?: { previewShape: string; kind: string }): boolean {
  return row?.previewShape === 'local' && row.kind === 'standard';
}

/** What this record is refused for on account of that declaration. A read that fails leaves the
 *  comment alone and says so in the log. */
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
      .select({ previewShape: projects.previewShape, kind: projects.kind })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!shapeScreensVerdicts(row)) return [];
  } catch (err) {
    logger.warn(
      { err, projectId },
      'skip-reason: could not read the declared preview shape — the verdict is not screened for it',
    );
    return [];
  }
  return [localPreviewSkipRefusal(criteria)];
}

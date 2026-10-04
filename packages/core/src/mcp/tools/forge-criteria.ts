// ISS-55 — `forge_criteria`: an issue's criteria and the verdicts on them, the MCP door onto the
// rules REST serves (`issues/criteria/routes.ts`), so the two refuse alike.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import {
  criteriaPutSchema,
  criterionItem,
  verdictIdentitySchema,
} from '../../issues/criteria/input-schemas.js';
import { listCriteria, putCriteria, recordVerdict } from '../../issues/criteria/store.js';
import { withCurrentDrafts } from '../../issues/criteria/storefront-draft.js';
import { egressShown } from '../../lib/data-egress.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalAgency,
  principalAuthorDeviceId,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z.object({
  action: z.enum(['list', 'put', 'verdict']),
  issueId: z.uuid(),
  /** action=put: the whole set, in order; a criterion without `n` takes the next number. */
  criteria: z.array(criterionItem).max(200).optional(),
  /** action=verdict. */
  criterion: z.number().int().min(1).optional(),
  verdict: z.string().trim().min(1).max(32).optional(),
  reason: z.string().trim().max(4000).nullable().optional(),
  identity: verdictIdentitySchema.nullable().optional(),
  evidence: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
});

async function issueOf(issueId: string) {
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) throw new Error('NOT_FOUND: issue not found');
  return issue;
}

async function criteriaShown(issue: { id: string; projectId: string }) {
  return egressShown(
    issue.projectId,
    'issue.criteria',
    await withCurrentDrafts(issue.projectId, await listCriteria(db, issue.id)),
    `the criteria of ${issue.id}`,
  );
}

export const forgeCriteriaTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_criteria',
  reach: 'project',
  route: '/api/issues',
  grant: { byAction: { list: 'issues:read', put: 'issues:write', verdict: 'issues:write' } },
  description:
    "An issue's acceptance criteria as rows, and the verdicts on them — what the `awaiting_release` gate reads. " +
    'list: { issueId } → live criteria in order, each with its latest verdict. ' +
    'put (the plan step): { issueId, criteria: [{ n?, statement, requirementCriterionId? }] } replaces the set; an unchanged criterion keeps its id, a reworded or removed one is retired with its verdicts; refused CRITERIA_LOCKED at awaiting_release, closed or dropped. ' +
    'verdict: { issueId, criterion, verdict: pass|short|fail|skipped, reason?, identity?, evidence? } — skipped needs a reason and never passes; pass, short and fail need an identity: { kind: commit, sha: <whole 40-hex> } | { kind: runtime, ref } | { kind: design, workflow, revision } | { kind: contract, ref, version } | { kind: storefront_draft, workflowId, draftVersion, environment } — a storefront draft (an unpublished provider workflow, e.g. Autoflow) names the workflow id and `draftVersion` exactly as `forge_storefront_target` `workflows[]` reports them, and a non-production environment the project document declares (preview); core reads the draft back from the storefront source every time the verdict is read: `corroboration: corroborated` while the source holds that draft version, `superseded` once the draft moved, `uncorroborated` when it cannot be read, each with `corroborationNote` saying why, and only a corroborated draft on a storefront-source project counts at awaiting_release (VERDICT_DRAFT_SUPERSEDED, VERDICT_UNCORROBORATED). Each fault is refused by name (VERDICT_COMMIT_NOT_FULL, VERDICT_IDENTITY_REQUIRED, VERDICT_SKIP_REASON_REQUIRED, VERDICT_CRITERION_UNKNOWN, VERDICT_STOREFRONT_DRAFT_SHAPE, VERDICT_ENVIRONMENT_UNKNOWN, …).',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const issue = await issueOf(input.issueId);
    if (input.action === 'list') {
      await assertPrincipalIsMember(principal, issue.projectId);
      return { criteria: await criteriaShown(issue) };
    }
    await assertPrincipalIsWriter(principal, issue.projectId);
    if (input.action === 'put') {
      if (!input.criteria)
        throw new Error('BAD_REQUEST: action=put takes `criteria`, the whole set in order');
      const { criteria } = criteriaPutSchema.parse({ criteria: input.criteria });
      await db.transaction((tx) => putCriteria(tx, issue.id, criteria));
      return { criteria: await criteriaShown(issue) };
    }
    if (input.criterion === undefined || input.verdict === undefined) {
      throw new Error('BAD_REQUEST: action=verdict takes `criterion` (its number) and `verdict`');
    }
    const { criterion, verdict } = input;
    const written = await db.transaction((tx) =>
      recordVerdict(tx, {
        issue,
        draft: {
          criterion,
          verdict,
          reason: input.reason ?? null,
          identity: input.identity ?? null,
          evidence: input.evidence ?? [],
        },
        author: {
          userId: principalUserId(principal),
          deviceId: principalAuthorDeviceId(principal),
          agency: principalAgency(principal),
        },
      }),
    );
    const row = (await criteriaShown(issue)).find((c) => c.n === criterion);
    return { verdictId: written.id, criterion: row };
  },
});

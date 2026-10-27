// one declaration of what a project's release asks of an issue (owner ruling on dev, 2026-10-04):
// `verdictsRequired: false` lets code ship and QA record its verdicts afterwards. The project
// document and the release hold (`issues/criteria-verdicts.ts:unearnedCriteriaReports`) read it here;
// `awaiting_release` asks no verdict at all (REQ-45 BC-2).
//
// `judgedOn` names the project's testing environment (REQ-36 BC-18..BC-20, owner ruling
// 2026-10-27): a release of a project naming one is proven only by passes judged on the build that
// environment serves — a `runtime` verdict at the release's commit — and a commit verdict, which
// still gates the merge, proves no release criterion. It is one name on the delivery policy rather
// than a flag on each environment, so a project has at most one by construction, and it is not
// `environments.<name>.testing`, which names the testing profile a run signs in with.

import { z } from "zod";

const VERDICTS_REQUIRED_DEFAULT = true;

// the project document's environment-name grammar (core `project-config/schema.ts:slug`)
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;

export const deliveryPolicySchema = z.strictObject({
	verdictsRequired: z.boolean().optional(),
	judgedOn: z.string().regex(ENVIRONMENT_NAME).optional(),
});

type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

export const verdictsRequiredOf = (
	delivery: DeliveryPolicy | null | undefined,
): boolean => delivery?.verdictsRequired ?? VERDICTS_REQUIRED_DEFAULT;

/** The environment a release's criteria are proven on, or null where commit verdicts prove them. */
export const judgedOnOf = (
	delivery: DeliveryPolicy | null | undefined,
): string | null => delivery?.judgedOn ?? null;

export const JUDGED_ON_REFUSAL_CODES = [
	"JUDGED_ON_UNDECLARED",
	"JUDGED_ON_PRODUCTION",
] as const;

/**
 * Why `delivery.judgedOn` cannot name `named`, or null where it can: it names an environment the
 * document declares, and never production, since a release is proven before it reaches production.
 */
export function judgedOnProblem(
	named: string,
	environments: Record<string, { tier: string }>,
): { code: (typeof JUDGED_ON_REFUSAL_CODES)[number]; detail: string } | null {
	const environment = environments[named];
	if (!environment) {
		return {
			code: "JUDGED_ON_UNDECLARED",
			detail: `delivery.judgedOn names ${named}, which the project document does not declare; name the environment a release is judged on before the owner reviews it, one of: ${Object.keys(environments).join(", ") || "none is declared"}`,
		};
	}
	if (environment.tier === "production") {
		return {
			code: "JUDGED_ON_PRODUCTION",
			detail: `delivery.judgedOn names ${named}, whose tier is production: a release is proven on its testing environment before it reaches production (REQ-36 BC-18), so name a staging, dev or preview environment`,
		};
	}
	return null;
}

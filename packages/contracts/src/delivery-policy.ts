// one declaration of what a project's release asks of an issue (owner ruling on dev, 2026-10-04):
// `verdictsRequired: false` lets code ship and QA record its verdicts afterwards. The project
// document and the release hold (`issues/criteria-verdicts.ts:unearnedCriteriaReports`) read it here;
// `awaiting_release` asks no verdict at all (REQ-45 BC-2).

import { z } from "zod";

const VERDICTS_REQUIRED_DEFAULT = true;

export const deliveryPolicySchema = z.strictObject({
	verdictsRequired: z.boolean().optional(),
});

type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

export const verdictsRequiredOf = (
	delivery: DeliveryPolicy | null | undefined,
): boolean => delivery?.verdictsRequired ?? VERDICTS_REQUIRED_DEFAULT;

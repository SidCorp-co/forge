// one declaration of what a project's delivery gate asks of an issue (owner ruling on dev,
// 2026-10-04): `verdictsRequired: false` lets code ship and QA record its verdicts afterwards. The
// project document, core's awaiting_release guard, the release hold and the move's record read it here.

import { z } from "zod";

const VERDICTS_REQUIRED_DEFAULT = true;

export const deliveryPolicySchema = z.strictObject({
	verdictsRequired: z.boolean().optional(),
});

type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

export const verdictsRequiredOf = (
	delivery: DeliveryPolicy | null | undefined,
): boolean => delivery?.verdictsRequired ?? VERDICTS_REQUIRED_DEFAULT;

/** The record field a move carries when it passed the gate with verdicts the gate would have refused. */
export const VERDICTS_WAIVED_FIELD = "verdicts-waived";

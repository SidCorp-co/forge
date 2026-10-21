// What a Forge instance says about itself (REQ-47), read and written by an instance admin at
// `/api/admin/instance-settings`. A write names the revision it was made against, so two admins
// writing at once cannot silently overwrite each other.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

export interface InstanceSettings {
	/** The project feedback about Forge itself is filed into; null until an admin names one. */
	forgeHomeProject: { id: string; slug: string; name: string } | null;
}

/** `GET /api/admin/instance-settings`; revision 0 is an instance that has said nothing yet. */
export interface InstanceSettingsView {
	revision: number;
	settings: InstanceSettings;
	updatedAt: string | null;
	updatedBy: { id: string; name: string | null } | null;
}

/** `PATCH /api/admin/instance-settings`: the keys to change, against the revision they were read at. */
export const instanceSettingsPatchSchema = z.strictObject({
	baseRevision: z.number().int().min(0),
	patch: z
		.strictObject({
			/** A project's id, or null to say there is none. */
			forgeHomeProjectId: z.uuid().nullable().optional(),
		})
		.refine((p) => Object.keys(p).length > 0, "patch names no setting"),
});
export type InstanceSettingsPatch = z.infer<typeof instanceSettingsPatchSchema>;
export const INSTANCE_SETTINGS_PATCH_SHAPE =
	"{ baseRevision: the revision you read, patch: { forgeHomeProjectId?: uuid | null } }";

export const INSTANCE_SETTINGS_REFUSAL_CODES = [
	"INSTANCE_SETTINGS_STALE",
	"INSTANCE_SETTINGS_PROJECT_UNKNOWN",
] as const;
export type InstanceSettingsRefusalCode =
	(typeof INSTANCE_SETTINGS_REFUSAL_CODES)[number];

export const INSTANCE_SETTINGS_REFUSAL_STATUSES = {
	INSTANCE_SETTINGS_STALE: 409,
} as const satisfies RefusalStatuses<InstanceSettingsRefusalCode>;

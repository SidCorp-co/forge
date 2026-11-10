import type { RefusalStatuses } from "./refusal.js";

// The code a device's plugin list is refused under when a project it serves stores an unreadable one.

export const PLUGIN_REFUSAL_CODES = ["PLUGIN_DESIGNATIONS_INVALID"] as const;

export type PluginRefusalCode = (typeof PLUGIN_REFUSAL_CODES)[number];

/**
 * What `GET /api/install/plugin.tar.gz` is refused under (REQ-25 BC-4): the instance designates no
 * forge plugin commit for it to serve, or the GitHub App could not read that commit as a marketplace.
 * Neither ever answers with another commit than the one designated.
 */
export const PLUGIN_ARCHIVE_REFUSAL_CODES = [
	"PLUGIN_ARCHIVE_UNDESIGNATED",
	"PLUGIN_ARCHIVE_UNREACHABLE",
] as const;

export type PluginArchiveRefusalCode =
	(typeof PLUGIN_ARCHIVE_REFUSAL_CODES)[number];

/** An operator designates the commit; the App's failure answers 424, as every provider's does. */
export const PLUGIN_ARCHIVE_REFUSAL_STATUSES = {
	PLUGIN_ARCHIVE_UNDESIGNATED: 503,
} as const satisfies RefusalStatuses<PluginArchiveRefusalCode>;

/** The response header naming the commit a served plugin archive holds. */
export const PLUGIN_ARCHIVE_COMMIT_HEADER = "x-forge-plugin-commit";

/** One project's pin of one plugin, on a box that serves it. */
export interface PluginPin {
	project: string;
	name: string;
	ref: string;
}

/**
 * Projects served by one box that pin one marketplace at different commits (REQ-26). The box holds
 * one clone of each marketplace, so it can honour none of the pins, whether they pin one plugin or
 * two of it; core drops them and reports the conflict here rather than letting the box pick one
 * silently.
 */
export interface PluginPinConflict {
	device: { id: string; name: string };
	marketplace: string;
	/** Each pin into that marketplace on that box, by project then plugin; unpinned designations are left out. */
	pins: PluginPin[];
}

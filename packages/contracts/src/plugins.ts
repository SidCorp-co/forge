// The code a device's plugin list is refused under when a project it serves stores an unreadable one.

export const PLUGIN_REFUSAL_CODES = ["PLUGIN_DESIGNATIONS_INVALID"] as const;

export type PluginRefusalCode = (typeof PLUGIN_REFUSAL_CODES)[number];

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

// The code a device's plugin list is refused under when a project it serves stores an unreadable one.

export const PLUGIN_REFUSAL_CODES = ["PLUGIN_DESIGNATIONS_INVALID"] as const;

export type PluginRefusalCode = (typeof PLUGIN_REFUSAL_CODES)[number];

/**
 * Two projects served by one box that pin one plugin at different commits (REQ-26 BC-2). The box
 * holds one clone, so it can honour neither pin; core drops the pin and reports the conflict here
 * rather than letting the box pick one silently.
 */
export interface PluginPinConflict {
	device: { id: string; name: string };
	marketplace: string;
	name: string;
	/** Each project on that box pinning the plugin, with its pin; unpinned projects are left out. */
	pins: { project: string; ref: string }[];
}

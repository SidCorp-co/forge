// The code a device's plugin list is refused under when a project it serves stores an unreadable one.

export const PLUGIN_REFUSAL_CODES = ["PLUGIN_DESIGNATIONS_INVALID"] as const;

export type PluginRefusalCode = (typeof PLUGIN_REFUSAL_CODES)[number];

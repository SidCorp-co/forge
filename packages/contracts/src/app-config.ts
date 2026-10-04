// The refusal vocabulary of a project's app configuration: the memory model and its reindex.

export const APP_CONFIG_REFUSAL_CODES = [
	"APP_CONFIG_REFUSED",
	"REINDEX_LIVE",
	"REINDEX_NOT_LIVE",
] as const;

export type AppConfigRefusalCode = (typeof APP_CONFIG_REFUSAL_CODES)[number];

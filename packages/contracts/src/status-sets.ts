// Two vocabularies core and the browser both read, declared once: core imports them at runtime.

/** The `memory_reindex` jsonb's own states (memory/chunk-reindex.ts writes them); not a session status. */
export const MEMORY_REINDEX_STATES = [
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export type MemoryReindexState = (typeof MEMORY_REINDEX_STATES)[number];

/** The channel register's filters, in the words its rows use: `awaiting` is a row some recipient still owes. */
export const REGISTER_STATUSES = [
	"awaiting",
	"overdue",
	"held",
	"answered",
	"closed",
] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

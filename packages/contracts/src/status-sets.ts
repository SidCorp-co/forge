// Two vocabularies core and the browser both read, declared once: core imports them at runtime.

/** The channel register's filters, in the words its rows use: `awaiting` is a row some recipient still owes. */
export const REGISTER_STATUSES = [
	"awaiting",
	"overdue",
	"held",
	"answered",
	"closed",
] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];

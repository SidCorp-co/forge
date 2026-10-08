// The script sandbox (REQ-37): one isolate both schedule scripts and the chat's computations run in.
// A script reads Forge only through ctx.forge.get, by GET, under a short-lived token of its owner the
// host holds; this file is what a run records about those reads and the refusal a read outside them
// meets. The engine and its host live in core's `sandbox` module.

import { z } from "zod";

/** The one language the sandbox runs. */
export const SCRIPT_LANGUAGE = "javascript" as const;

/** What a read outside GET on the run's own project meets, inside the script, naming the method or path. */
export const SCRIPT_READ_REFUSED = "SCRIPT_READ_REFUSED" as const;

/** The most reads one run may make; the next is refused by name. */
export const SCRIPT_READ_CAP = 100;

/** The most bytes of one read's body handed into the script; a larger body is refused by name. */
export const SCRIPT_READ_BODY_CAP_BYTES = 2_000_000;

/**
 * One read a run made: the method and path it asked for and the status the REST app answered, or
 * null with the code it was refused under where no request was made: SCRIPT_READ_REFUSED for a
 * read outside GET on the run's project, or the turn-authority code where the owner cannot be read as.
 */
export const ScriptReadSchema = z
	.object({
		method: z.string().min(1).max(16),
		path: z.string().max(2048),
		status: z.number().int().min(100).max(599).nullable(),
		refused: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]*$/)
			.optional(),
	})
	.strict();
export type ScriptRead = z.infer<typeof ScriptReadSchema>;

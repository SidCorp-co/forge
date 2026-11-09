// The script sandbox (REQ-37): one isolate both schedule scripts and the chat's computations run in.
// A script reads Forge only through ctx.forge.get, by GET, under a short-lived token of its owner the
// host holds; this file is what a run records about those reads and the refusal a read outside them
// meets. The engine and its host live in core's `sandbox` module.

import { z } from "zod";
import { supportReadSecretSchema } from "./support.js";

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

// A script schedule's doors past ctx.forge.get (REQ-87): declared read-only calls on its project's
// forge-ops target (BC-1), feedback filed on its own project joined by a signal key (BC-2), and a
// small state kept between firings (BC-3), each recorded on the fire (BC-4). A chat computation
// holds none of them.

/** The ops target a script schedule reads through: the forge-ops CLI on the project's box. */
export const SCRIPT_OPS_TARGET = "forge-ops" as const;

/** The forge-ops tools that only read. `deploy` and any tool not named here are never read-only. */
export const FORGE_OPS_READ_TOOLS = [
	"list_targets",
	"status",
	"logs",
	"job_status",
] as const;

/** The forge-ops tool that runs a command on a target: read-only only where its `command` only reads. */
export const FORGE_OPS_EXEC_TOOL = "exec_command" as const;

/**
 * A forge-ops command on a service (`exec_command` with `service`) is a NAME its ops dashboard vetted
 * for that service, such as `health`, never a shell line: forge-ops refuses anything else itself.
 */
export const FORGE_OPS_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** The most lines forge-ops' `logs` answers; a `tail` past it is refused by forge-ops. */
export const FORGE_OPS_LOGS_TAIL_MAX = 2000;

/**
 * Why a script's ops call, filing or state write was refused, as the script sees it thrown (`e.code`)
 * and the fire records it. SCRIPT_OPS_UNDECLARED: a call the schedule does not declare.
 * SCRIPT_OPS_NOT_READ_ONLY: a declared call that is not read-only on the target, refused before the
 * script runs at all. SCRIPT_OPS_FAILED: a declared call that could not be run for its own reason
 * (its secret is not held, the box could not start it). SCRIPT_OPS_BOX_UNREACHABLE: a declared call
 * that never reached a box: none bound is online, the box dropped and did not come back within the
 * call's time, or it took the call and never answered; one cause shared by every call of the firing.
 * SCRIPT_OPS_OVER_TARGET_LIMIT: a declared call whose fixed arguments the target refuses
 * (a `logs` tail past FORGE_OPS_LOGS_TAIL_MAX). SCRIPT_FEEDBACK_REFUSED: a filing that does not fit, or a run with no project to file
 * on. SCRIPT_STATE_REFUSED: a state that is not a JSON object, or is past its cap.
 */
export const SCRIPT_DOOR_REFUSALS = [
	"SCRIPT_OPS_UNDECLARED",
	"SCRIPT_OPS_NOT_READ_ONLY",
	"SCRIPT_OPS_FAILED",
	"SCRIPT_OPS_BOX_UNREACHABLE",
	"SCRIPT_OPS_OVER_TARGET_LIMIT",
	"SCRIPT_FEEDBACK_REFUSED",
	"SCRIPT_STATE_REFUSED",
] as const;
export type ScriptDoorRefusal = (typeof SCRIPT_DOOR_REFUSALS)[number];

/** The most ops calls one firing may make; the next is refused by name. */
export const SCRIPT_OPS_CALL_CAP = 30;
/** The most feedback filings one firing may make. */
export const SCRIPT_FEEDBACK_CAP = 10;
/** The most bytes a schedule's state takes, as JSON text. */
export const SCRIPT_STATE_CAP_BYTES = 16_384;
/** The longest one ops call may run on the box, and how long when it names none. */
export const SCRIPT_OPS_TIMEOUT_MAX_MS = 120_000;
export const SCRIPT_OPS_TIMEOUT_DEFAULT_MS = 60_000;

/** The forge-ops CLI on the box: an absolute path ending in `/forge-ops`, with no . or .. segment. */
const opsProgramSchema = z
	.string()
	.max(300)
	.regex(
		/^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?:[A-Za-z0-9._+@-]+\/)*forge-ops$/,
		"the program is the forge-ops CLI by its absolute path on the box, such as /home/dev/.local/bin/forge-ops",
	);

const opsArgValueSchema = z.union([
	z.string().max(2000),
	z.number().finite(),
	z.boolean(),
]);

/** One call a script schedule declares: the name the script calls (`ctx.ops.<name>()`), the forge-ops tool, its fixed arguments. */
export const scriptOpsCallSchema = z.strictObject({
	name: z
		.string()
		.regex(
			/^[a-z][A-Za-z0-9_]{0,39}$/,
			"a call's name is what the script writes after ctx.ops.: a letter, then letters, digits or _, at most 40",
		),
	tool: z
		.string()
		.regex(
			/^[a-z][a-z0-9_]{0,39}$/,
			"a forge-ops tool, such as status, logs or exec_command",
		),
	/** The tool's arguments, fixed here: the script passes none (`{ target, command }` for exec_command). */
	args: z
		.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/),
			opsArgValueSchema,
		)
		.optional(),
	timeoutMs: z
		.number()
		.int()
		.min(1000)
		.max(SCRIPT_OPS_TIMEOUT_MAX_MS)
		.optional(),
	/**
	 * Why a named forge-ops command (`exec_command` with `service`) only reads, kept on the schedule:
	 * core cannot read a vetted name's effect, so the one who declares the call says it.
	 */
	readOnlyBecause: z.string().trim().min(1).max(300).optional(),
});
export type ScriptOpsCallDeclaration = z.infer<typeof scriptOpsCallSchema>;

/**
 * What a script schedule declares it may call (REQ-87 BC-1), saved on the schedule. `secrets` is the
 * forge-ops credential as project secrets (ISS-707): core reads each from the vault and the box sets
 * it on that one call's process, so no call runs on a credential the box holds of its own.
 */
const scriptOpsSecretsSchema = z
	.array(supportReadSecretSchema)
	.min(
		1,
		"name the forge-ops credential as a project secret: secrets: [{ env, secret: secret://<scope>/<name> }]",
	)
	.max(5)
	.refine(
		(ss) => new Set(ss.map((x) => x.env)).size === ss.length,
		"two secrets share a variable; a variable is named once",
	);

/** A declaration as it is saved: its credential named as project secrets, always (ISS-707). */
export const scriptOpsSchema = z.strictObject({
	program: opsProgramSchema,
	secrets: scriptOpsSecretsSchema,
	calls: z
		.array(scriptOpsCallSchema)
		.min(1)
		.max(20)
		.refine(
			(calls) => new Set(calls.map((c) => c.name)).size === calls.length,
			"two calls share a name; a name names one call",
		),
});

/**
 * A declaration as a firing reads it back. Priced amnesty `script-ops-box-credential` (ISS-707,
 * .forge/conformance.json): a declaration stored before `secrets` was asked holds none, and it still
 * runs on the box's own forge-ops credential, each call warning by name, so a live watch does not go
 * dark. It trades a credential Forge does not hold or audit for that schedule; it ends when the
 * schedule is saved with `secrets`, which every save requires.
 */
export const storedScriptOpsSchema = scriptOpsSchema.extend({
	secrets: scriptOpsSecretsSchema.optional(),
});
export type ScriptOpsDeclaration = z.infer<typeof storedScriptOpsSchema>;

/** One ops call a firing made, as its run history keeps it: never what the call printed. */
export const ScriptOpsCallSchema = z
	.object({
		name: z.string().max(64),
		/** `answered`: the box ran it and it exited; `refused`/`failed`: it did not run, under `code`. */
		outcome: z.enum(["answered", "refused", "failed"]),
		exitCode: z.number().int().nullable().optional(),
		timedOut: z.boolean().optional(),
		code: z.enum(SCRIPT_DOOR_REFUSALS).optional(),
		durationMs: z.number().int().min(0).optional(),
		/** Why the call ran on a credential Forge does not hold (amnesty `script-ops-box-credential`, ISS-707). */
		warning: z.string().max(400).optional(),
	})
	.strict();
export type ScriptOpsCall = z.infer<typeof ScriptOpsCallSchema>;

/** One filing a firing made: the item it filed or joined, or why it was refused. */
export const ScriptFilingSchema = z
	.object({
		signalKey: z.string().max(200),
		/** The item's key (`FB-12`); null where the filing was refused. */
		key: z.string().max(32).nullable(),
		/** True where it filed a new item, false where it joined the open one with its signal key. */
		created: z.boolean(),
		refused: z.enum(SCRIPT_DOOR_REFUSALS).optional(),
	})
	.strict();
export type ScriptFiling = z.infer<typeof ScriptFilingSchema>;

/** What a script fills to file feedback: one item on its own project, joined by `signalKey`. */
export const SCRIPT_FILING_SHAPE =
	"{ kind: bug | change_request | question | idea, title, body?, severity?: low | medium | high | critical, signalKey }";

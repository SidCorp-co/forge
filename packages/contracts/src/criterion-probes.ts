// One declaration of a kept probe (REQ-36 BC-6, BC-12; ISS-469): the stored, replayable exercise of
// the running build a verdict on an observable criterion rests on, and the result it expects. Core's
// table CHECKs, the verdict door and its refusals read the shape from here, and the release run that
// replays kept probes on each verified deploy (ISS-470) reads the same one, so a probe needs no
// person to run it again. Storing a probe never runs it.

import { z } from "zod";

/** `request`: an HTTP request to the running build. `command`: a program run beside it. */
export const PROBE_KINDS = ["request", "command"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const PROBE_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;

/**
 * Whose credential a request goes out with. A probe stores none: `replayer` says whoever replays it
 * attaches its own, `anonymous` that it is sent with none.
 */
export const PROBE_CALLERS = ["anonymous", "replayer"] as const;

/** The variable a replayer sets to the running build's origin before it runs a `command` probe. */
export const PROBE_ORIGIN_ENV = "FORGE_PROBE_ORIGIN" as const;

export const PROBE_LIMITS = {
	path: 2000,
	headers: 20,
	headerValue: 1000,
	body: 20_000,
	argv: 50,
	arg: 2000,
	includes: 20,
	include: 500,
	/** The stored probe as JSON text, which the table's CHECK holds too. */
	stored: 64_000,
} as const;

// a path on the build's own origin, so the same probe replays against whichever deployment serves it
const ORIGIN_PATH = /^\/(?!\/)\S*$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/u;
// a service the project document declares on an environment (`environments.<name>.services`)
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
// a path inside the repository the build was made from: relative, and never climbing out of it
const IN_TREE_DIR = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.@-]+(?:\/[\w.@-]+)*$/u;

const includesSchema = z
	.array(z.string().min(1).max(PROBE_LIMITS.include))
	.max(PROBE_LIMITS.includes);

const requestProbeSchema = z.strictObject({
	kind: z.literal("request"),
	request: z.strictObject({
		method: z.enum(PROBE_METHODS),
		path: z
			.string()
			.max(PROBE_LIMITS.path)
			.regex(
				ORIGIN_PATH,
				"a path on the running build's origin, starting with one `/` (no scheme or host)",
			),
		headers: z
			.record(
				z
					.string()
					.regex(HEADER_NAME, "a header name (letters, digits and `-`)"),
				z.string().min(1).max(PROBE_LIMITS.headerValue),
			)
			.refine((h) => Object.keys(h).length <= PROBE_LIMITS.headers, {
				message: `at most ${PROBE_LIMITS.headers} headers`,
			})
			.optional(),
		body: z.string().max(PROBE_LIMITS.body).optional(),
		as: z.enum(PROBE_CALLERS),
		/** The declared service that answers the path; absent, the production environment's own `url`. */
		service: z
			.string()
			.regex(SERVICE_NAME, "a service the project document declares (a lowercase slug)")
			.optional(),
	}),
	expect: z.strictObject({
		status: z.number().int().min(100).max(599),
		bodyIncludes: includesSchema.optional(),
	}),
});

const commandProbeSchema = z.strictObject({
	kind: z.literal("command"),
	command: z.strictObject({
		argv: z
			.array(z.string().min(1).max(PROBE_LIMITS.arg))
			.min(1)
			.max(PROBE_LIMITS.argv),
		cwd: z
			.string()
			.regex(
				IN_TREE_DIR,
				"a directory inside the repository, relative to its root",
			)
			.optional(),
	}),
	expect: z.strictObject({
		exitCode: z.number().int().min(0).max(255),
		stdoutIncludes: includesSchema.optional(),
	}),
});

export const criterionProbeSchema = z.discriminatedUnion("kind", [
	requestProbeSchema,
	commandProbeSchema,
]);
export type CriterionProbe = z.infer<typeof criterionProbeSchema>;

export const PROBE_SHAPE = `{ kind: "request", request: { method, path: "/…" on the running build's origin, headers?, body?: text, as: "anonymous" | "replayer", service?: a service the environment declares }, expect: { status, bodyIncludes?: [text] } } or { kind: "command", command: { argv: [program, …args], cwd?: an in-tree directory }, expect: { exitCode, stdoutIncludes?: [text] } }; a command reads the build's origin from ${PROBE_ORIGIN_ENV}, and a probe carries no credential`;

/** A probe as the criteria read answers it: what it runs, what it expects, and when it was kept. */
export type CriterionProbeView = CriterionProbe & {
	id: string;
	keptAt: string;
};

export const PROBE_REFUSAL_CODES = [
	/** The probe is not one of the two shapes; the refusal's path names the field. */
	"VERDICT_PROBE_SHAPE",
	/** The probe holds a credential, or a header that carries one. */
	"VERDICT_PROBE_SECRET",
	/** A pass or short on an observable criterion with no probe sent and none kept. */
	"VERDICT_PROBE_REQUIRED",
	/** A probe sent on a code property, which the review judges against the diff. */
	"VERDICT_PROBE_CODE_PROPERTY",
	/** A request the origin it would be replayed against does not answer, or one whose origin is unknown. */
	"VERDICT_PROBE_ROUTE",
] as const;
export type ProbeRefusalCode = (typeof PROBE_REFUSAL_CODES)[number];

/** What one kept probe did on a verified deploy's replay (REQ-36 BC-12; ISS-470). */
export const PROBE_REPLAY_OUTCOMES = [
	/** It ran against the served build and answered what it expects. */
	"held",
	/** It ran and answered something else: a fail verdict on the served identity. */
	"failed",
	/** It could not be run against the served build, so it counts as no pass. */
	"could_not_run",
	/** A command probe: it runs only on a runner in a checkout of the served commit, never in core. */
	"not_replayed",
] as const;
export type ProbeReplayOutcome = (typeof PROBE_REPLAY_OUTCOMES)[number];

export interface ProbeReplayResult {
	issueId: string;
	criterion: number;
	probeId: string;
	outcome: ProbeReplayOutcome;
	/** What it answered against what it expects, or why it did not run. Never a credential. */
	detail: string;
	/** The verdict the replay wrote, or null where it wrote none. */
	verdictId: string | null;
}

/** One release run's replay of the kept probes, kept on the run and read back with its state. */
export interface ProbeReplayRecord {
	/** The commit the verified deploy serves, which each verdict names; null where none is named. */
	served: string | null;
	replayedAt: string;
	/** Why nothing was replayed, or null where the replay ran. */
	skipped: string | null;
	results: ProbeReplayResult[];
	/** The issues it sent to reopen. */
	reopened: string[];
	/** The claimed issues it kept from closing: a probe of theirs could not run. */
	held: string[];
}

/**
 * The production environment a request probe is replayed against, as the project document declares
 * it: its own `url`, its `services`, and `routes`, the path prefixes each service answers. The
 * `url` answers every path no service's prefix claims.
 */
export interface ProbeRouting {
	environment: string;
	url: string | null;
	services: Readonly<Record<string, string>>;
	routes: Readonly<Record<string, readonly string[]>> | null;
}

/** Whether `prefix` claims `path`: the path is the prefix, or continues it past a `/`. */
function claims(prefix: string, path: string): boolean {
	const bare = path.split(/[?#]/u)[0] ?? path;
	if (prefix.endsWith("/")) return bare.startsWith(prefix) || bare === prefix.slice(0, -1);
	return bare === prefix || bare.startsWith(`${prefix}/`);
}

/** The service whose longest prefix claims `path`, or null where the environment's `url` answers it. */
export function serviceRouting(
	path: string,
	routes: Readonly<Record<string, readonly string[]>>,
): { service: string; prefix: string } | null {
	let best: { service: string; prefix: string } | null = null;
	for (const [service, prefixes] of Object.entries(routes)) {
		for (const prefix of prefixes) {
			if (claims(prefix, path) && prefix.length > (best?.prefix.length ?? -1)) {
				best = { service, prefix };
			}
		}
	}
	return best;
}

/**
 * Why a request probe could not be replayed where it says, or null where the origin it resolves to
 * answers its path (ISS-470): a service the environment does not declare, an environment with
 * services but no `routes` (which origin answers a path is then unknown, and is never guessed from
 * the path), a path another origin answers, and an environment with no origin at all.
 */
export function probeRouteFault(
	request: { path: string; service?: string | undefined },
	routing: ProbeRouting,
): string | null {
	const env = `production environment \`${routing.environment}\``;
	const declared = Object.keys(routing.services);
	const { service, path } = request;
	if (service !== undefined && !declared.includes(service)) {
		const known = declared.length > 0 ? `it declares ${declared.join(", ")}` : "it declares none";
		return `${env} declares no service \`${service}\` (${known}); name one of those, or leave \`service\` out to use its \`url\``;
	}
	if (declared.length > 0 && routing.routes === null) {
		return `${env} declares services (${declared.join(", ")}) and no \`routes\`, so which origin answers \`${path}\` is not known; declare \`environments.${routing.environment}.routes\`, the path prefixes each service answers (for example { "${declared[0]}": ["/api"] })`;
	}
	const owner = routing.routes === null ? null : serviceRouting(path, routing.routes);
	if (service === undefined) {
		if (owner !== null) {
			return `\`${path}\` is answered by service \`${owner.service}\` (it routes \`${owner.prefix}\`), not by ${env}'s \`url\`; send \`service: "${owner.service}"\``;
		}
		if (routing.url === null) {
			return `${env} declares no \`url\`, so a probe naming no service has no origin to be replayed against`;
		}
		return null;
	}
	if (owner?.service === service) return null;
	const answeredBy =
		owner === null ? `${env}'s \`url\`, which answers every path no service routes; leave \`service\` out` : `service \`${owner.service}\` (it routes \`${owner.prefix}\`); send \`service: "${owner.service}"\``;
	return `service \`${service}\` does not route \`${path}\`: it is answered by ${answeredBy}`;
}

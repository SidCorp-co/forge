// Production monitoring as a Forge integration (ISS-1225, owner ruling 2026-11-12): whoever runs a
// Prometheus connects it to Forge, and a project binds that connection with
// role `monitoring`, its target naming what to scrape and probe, whether a host agent remote-writes
// for it, and the alert rules it owns. Core renders the rules (a closed set of kinds, each scoped to
// the project's own series) for the connection's ruler, serves the targets its Prometheus discovers,
// takes the agent's writes under the project's token, and turns each firing alert into one feedback
// item on the project. Forge bundles no Prometheus of its own.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

/** The `evaluation_interval` the monitoring guide's Prometheus config sets, and the floor a rule's `for` is read against. */
export const MONITORING_EVALUATION_SECONDS = 30;
/** A rule's `for` is at least two evaluations: a breach must persist past one before it fires. */
export const MONITORING_FOR_MIN_SECONDS = 2 * MONITORING_EVALUATION_SECONDS;

export const MONITORING_RULE_KINDS = [
	"target_down",
	"probe_failed",
	"latency_quantile_above",
	"error_ratio_above",
	"disk_free_below",
	"series_above",
] as const;
export type MonitoringRuleKind = (typeof MONITORING_RULE_KINDS)[number];

export const MONITORING_SEVERITIES = ["low", "medium", "high"] as const;
export const MONITORING_PROBE_MODULES = ["http_2xx", "tcp_connect"] as const;

/** The name a rule's `target` gives the host agent: its series carry the project label and no target. */
export const MONITORING_AGENT_TARGET = "agent";

/** The label every series, target and alert of a project carries, and the one a rule is scoped to. */
export const MONITORING_PROJECT_LABEL = "forge_project";
export const MONITORING_TARGET_LABEL = "forge_target";

/** The agent token: this prefix and 43 base64url characters (256 random bits). */
export const MONITORING_AGENT_TOKEN_PREFIX = "fmt_";
export const MONITORING_AGENT_TOKEN_PATTERN = /^fmt_[A-Za-z0-9_-]{43}$/;

/**
 * The two tokens Forge mints per connection, shown once and kept as their SHA-256: `sd` is what the
 * connection's Prometheus presents to discover targets and pull the rule file, `alerts` what its
 * Alertmanager presents to post alerts.
 */
export const MONITORING_CONNECTION_TOKEN_KINDS = ["sd", "alerts"] as const;
export type MonitoringConnectionTokenKind =
	(typeof MONITORING_CONNECTION_TOKEN_KINDS)[number];
export const MONITORING_CONNECTION_TOKEN_PREFIXES = {
	sd: "fms_",
	alerts: "fma_",
} as const satisfies Record<MonitoringConnectionTokenKind, string>;
export const MONITORING_CONNECTION_TOKEN_PATTERN = /^fm[sa]_[A-Za-z0-9_-]{43}$/;

/** Where the setup list puts Forge's rule file on the connection's host; `rule_files` must name it. */
export const MONITORING_RULES_DIR = "/etc/prometheus/forge-rules";

/** A door of one connection, by path: what its Prometheus and Alertmanager call. */
export const monitoringConnectionDoor = (
	connectionId: string,
	door: "targets?job=scrape" | "targets?job=probe" | "rules" | "alerts",
) => `/api/monitoring/connections/${connectionId}/${door}`;

/** The feedback a firing alert files: seen on this screen, joined by `monitoring:<fingerprint>`. */
export const MONITORING_FEEDBACK_SCREEN = "monitoring";
export const monitoringSignalKey = (fingerprint: string) =>
	`monitoring:${fingerprint}`;

const DURATION =
	/^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/;
const UNIT_SECONDS = [31_536_000, 604_800, 86_400, 3_600, 60, 1, 0.001];

/** A Prometheus duration (`30s`, `5m`, `1h30m`) in seconds, or null for text that is not one. */
export function promDurationSeconds(text: string): number | null {
	if (text === "") return null;
	const m = DURATION.exec(text);
	if (!m) return null;
	let total = 0;
	UNIT_SECONDS.forEach((unit, i) => {
		const n = m[i + 1];
		if (n !== undefined) total += Number(n) * unit;
	});
	return total;
}

const name = () =>
	z
		.string()
		.regex(/^[a-z0-9-]{1,40}$/, "a name of 1-40 characters: a-z, 0-9 and -");
const duration = () =>
	z.string().refine((v) => promDurationSeconds(v) !== null, {
		message: "a Prometheus duration such as 30s, 5m or 1h30m",
	});
const httpUrl = () =>
	z
		.string()
		.max(500)
		.regex(/^https?:\/\//, "an http:// or https:// URL")
		.refine((v) => URL.canParse(v), { message: "Invalid URI" });
const metric = () =>
	z
		.string()
		.regex(
			/^[a-zA-Z_:][a-zA-Z0-9_:]{0,199}$/,
			"a Prometheus metric name such as http_requests_total",
		);

const scrapeSchema = z.strictObject({
	name: name(),
	url: httpUrl(),
	interval: duration().optional(),
});

const probeSchema = z.strictObject({
	name: name(),
	url: httpUrl(),
	module: z.enum(MONITORING_PROBE_MODULES).optional(),
});

const ruleSchema = z.strictObject({
	name: name(),
	kind: z.enum(MONITORING_RULE_KINDS),
	target: name(),
	threshold: z.number().finite().optional(),
	quantile: z.number().gt(0).lt(1).optional(),
	metric: metric().optional(),
	for: duration(),
	severity: z.enum(MONITORING_SEVERITIES),
});
export type MonitoringRule = z.infer<typeof ruleSchema>;

/** What each kind needs beyond its target, and the bounds of its threshold. */
const KIND_NEEDS: Record<
	MonitoringRuleKind,
	{ metric: boolean; quantile: boolean; threshold: "none" | "any" | "ratio" }
> = {
	target_down: { metric: false, quantile: false, threshold: "none" },
	probe_failed: { metric: false, quantile: false, threshold: "none" },
	latency_quantile_above: { metric: true, quantile: true, threshold: "any" },
	error_ratio_above: { metric: true, quantile: false, threshold: "ratio" },
	disk_free_below: { metric: false, quantile: false, threshold: "ratio" },
	series_above: { metric: true, quantile: false, threshold: "any" },
};

/** Which registered names a kind's `target` may name. */
const KIND_TARGETS: Record<MonitoringRuleKind, "scrape" | "probe" | "series"> =
	{
		target_down: "scrape",
		probe_failed: "probe",
		latency_quantile_above: "series",
		error_ratio_above: "series",
		disk_free_below: "series",
		series_above: "series",
	};

function thresholdFault(
	rule: { threshold?: number | undefined },
	wants: "none" | "any" | "ratio",
): string | null {
	const t = rule.threshold;
	if (wants === "none") return t === undefined ? null : "takes no threshold";
	if (t === undefined) return "needs a threshold";
	if (wants === "ratio" && (t < 0 || t > 1)) {
		return "needs a threshold from 0 to 1, a ratio";
	}
	return null;
}

const monitoringBlockSchema = z.strictObject({
	scrape: z.array(scrapeSchema).max(50).optional(),
	probe: z.array(probeSchema).max(50).optional(),
	agent: z.strictObject({ enabled: z.boolean() }).optional(),
	rules: z.array(ruleSchema).max(100).optional(),
});

/** One fault of a monitoring binding's target, at a JSON pointer inside it. */
export interface MonitoringFault {
	code: MonitoringConfigRefusalCode | "SCHEMA_VIOLATION";
	path: string;
	detail: string;
}

function namesUnique(
	out: MonitoringFault[],
	list: readonly { name: string }[],
	at: string,
	reserved: readonly string[] = [],
) {
	const seen = new Set<string>(reserved);
	list.forEach((item, i) => {
		if (seen.has(item.name)) {
			out.push({
				code: "MONITORING_NAME_TAKEN",
				path: `/${at}/${i}/name`,
				detail: `${at} name \`${item.name}\` is taken${reserved.includes(item.name) ? " by the host agent" : ` by another of this project's ${at} entries`}; each name is unique within its list`,
			});
		}
		seen.add(item.name);
	});
}

function targetKnown(config: MonitoringConfig, rule: MonitoringRule): boolean {
	const wants = KIND_TARGETS[rule.kind];
	if (wants === "probe") {
		return (config.probe ?? []).some((p) => p.name === rule.target);
	}
	if ((config.scrape ?? []).some((s) => s.name === rule.target)) return true;
	return (
		wants === "series" &&
		config.agent?.enabled === true &&
		rule.target === MONITORING_AGENT_TARGET
	);
}

const TARGET_NAMES = {
	probe: "a `probe` of this project",
	scrape: "a `scrape` of this project",
	series: "a `scrape` of this project, or `agent` with `agent.enabled`",
} as const;

function ruleFaults(out: MonitoringFault[], config: MonitoringConfig) {
	(config.rules ?? []).forEach((rule, i) => {
		const at = `/rules/${i}`;
		if (!targetKnown(config, rule)) {
			out.push({
				code: "MONITORING_RULE_TARGET_UNKNOWN",
				path: `${at}/target`,
				detail: `rule \`${rule.name}\` (${rule.kind}) targets \`${rule.target}\`, which is not ${TARGET_NAMES[KIND_TARGETS[rule.kind]]}; a rule watches only what its own project registers`,
			});
		}
		if ((promDurationSeconds(rule.for) ?? 0) < MONITORING_FOR_MIN_SECONDS) {
			out.push({
				code: "MONITORING_FOR_TOO_SHORT",
				path: `${at}/for`,
				detail: `rule \`${rule.name}\` has for ${rule.for}; a breach must persist past one evaluation, so for is at least ${MONITORING_FOR_MIN_SECONDS}s (two evaluations of ${MONITORING_EVALUATION_SECONDS}s)`,
			});
		}
		const needs = KIND_NEEDS[rule.kind];
		const shape = (field: string, needed: boolean, given: boolean) => {
			if (needed === given) return;
			out.push({
				code: "SCHEMA_VIOLATION",
				path: `${at}/${field}`,
				detail: `${rule.kind} ${needed ? "needs" : "takes no"} ${field}`,
			});
		};
		shape("metric", needs.metric, rule.metric !== undefined);
		shape("quantile", needs.quantile, rule.quantile !== undefined);
		const wrong = thresholdFault(rule, needs.threshold);
		if (wrong) {
			out.push({
				code: "SCHEMA_VIOLATION",
				path: `${at}/threshold`,
				detail: `${rule.kind} ${wrong}`,
			});
		}
	});
}

/** What the target's own shape cannot say: names taken, a rule's target, its `for`, its fields. */
export function monitoringConfigFaults(
	config: MonitoringConfig,
): MonitoringFault[] {
	const out: MonitoringFault[] = [];
	namesUnique(out, config.scrape ?? [], "scrape", [MONITORING_AGENT_TARGET]);
	namesUnique(out, config.probe ?? [], "probe");
	namesUnique(out, config.rules ?? [], "rules");
	ruleFaults(out, config);
	return out;
}

/** A monitoring binding's target past its provider: scrape, probe, the host agent and rules. */
export const monitoringConfigSchema = monitoringBlockSchema;
export type MonitoringConfig = z.infer<typeof monitoringBlockSchema>;

/** The codes a monitoring binding is refused by. */
export const MONITORING_CONFIG_REFUSAL_CODES = [
	"MONITORING_RULE_KIND_UNKNOWN",
	"MONITORING_RULE_TARGET_UNKNOWN",
	"MONITORING_FOR_TOO_SHORT",
	"MONITORING_NAME_TAKEN",
	/** The connection's `ruler` is `none`: its backend takes no rules, so a binding carrying some is refused. */
	"MONITORING_BACKEND_TAKES_NO_RULES",
	/** The connection's ruler (`mimir`) refused the rendered rule group, or could not be reached. */
	"MONITORING_RULES_REFUSED",
	/**
	 * The connection holds no credentials, or its server answers without them or refuses them: Forge
	 * sends no project's data to an open endpoint.
	 */
	"MONITORING_SERVER_UNAUTHENTICATED",
	/** A connection whose `ruler` is `mimir` names no `rulerUrl`, so it could push no rule group. */
	"MONITORING_RULER_URL_MISSING",
	/** The binding scrapes or probes, and the server's config holds no Forge http_sd job for it. */
	"MONITORING_DISCOVERY_NOT_WIRED",
	/** The binding asks for the host agent, and the server runs no remote-write receiver. */
	"MONITORING_REMOTE_WRITE_DISABLED",
	/** Rules on a `file` ruler whose `rule_files` miss Forge's rules directory, or with no lifecycle. */
	"MONITORING_RULES_NOT_WIRED",
	/** Rules on a server with no Alertmanager attached: an alert could never reach Forge. */
	"MONITORING_NO_ALERTMANAGER",
] as const;
export type MonitoringConfigRefusalCode =
	(typeof MONITORING_CONFIG_REFUSAL_CODES)[number];

/** The code a binding target's schema issue is refused by: an unmatched rule `kind` is an unknown kind. */
export function monitoringRefusalCode(issue: {
	code: string;
	path: readonly PropertyKey[];
}): MonitoringConfigRefusalCode | null {
	return issue.code === "invalid_value" &&
		issue.path[0] === "target" &&
		issue.path[1] === "rules" &&
		issue.path.at(-1) === "kind"
		? "MONITORING_RULE_KIND_UNKNOWN"
		: null;
}

/** The codes the monitoring doors answer with, beside the binding's. */
export const MONITORING_REFUSAL_CODES = [
	/** No monitoring connection serves the call: the project binds none. */
	"MONITORING_NOT_CONNECTED",
	/** A remote write naming a series whose `forge_project` is not the token's project, or none. */
	"MONITORING_SERIES_FOREIGN_PROJECT",
	/** A remote write whose body is not snappy-compressed remote-write protobuf. */
	"MONITORING_WRITE_UNDECODABLE",
	/** An alert naming no project bound to the posting connection in its `forge_project` label. */
	"MONITORING_ALERT_PROJECT_UNKNOWN",
	/** The `job` query is neither `scrape` nor `probe`. */
	"MONITORING_JOB_UNKNOWN",
	/** The bearer is not the door's token: a project's agent token, the connection's sd or alerts token (401). */
	"MONITORING_TOKEN_INVALID",
	/** Prometheus refused a forwarded write (its own 4xx) or could not take it (502). */
	"MONITORING_FORWARD_FAILED",
] as const;
export type MonitoringRefusalCode = (typeof MONITORING_REFUSAL_CODES)[number];

export const MONITORING_REFUSAL_STATUSES = {
	MONITORING_NOT_CONNECTED: 409,
	MONITORING_RULES_REFUSED: 503,
	MONITORING_SERIES_FOREIGN_PROJECT: 403,
	MONITORING_WRITE_UNDECODABLE: 400,
	MONITORING_JOB_UNKNOWN: 400,
} as const satisfies RefusalStatuses<
	MonitoringRefusalCode | MonitoringConfigRefusalCode
>;

/** How the connection's backend takes a project's rules (owner ruling 2026-11-12). */
export const MONITORING_RULERS = ["mimir", "file", "none"] as const;
export type MonitoringRuler = (typeof MONITORING_RULERS)[number];

const connectionConfigBase = z.strictObject({
	/** The Prometheus (or Mimir query frontend) core reads and forwards a host agent's writes to. */
	prometheusUrl: httpUrl(),
	/** The basic-auth user Forge calls the server as; the server's `web.yml` holds its bcrypt. */
	prometheusUser: z.string().min(1).max(200).optional(),
	/**
	 * `mimir`: core pushes each project's rule group to the Mimir or Cortex ruler API at `rulerUrl`.
	 * `file`: the connection's host pulls the rendered rule file from Forge into `rule_files` and
	 * reloads. `none`: the backend takes no rules, and a binding carrying some is refused
	 * MONITORING_BACKEND_TAKES_NO_RULES.
	 */
	ruler: z.enum(MONITORING_RULERS),
	rulerUrl: httpUrl().optional(),
	/** The tenant a Mimir or Cortex backend reads from `X-Scope-OrgID`. */
	tenant: z.string().min(1).max(200).optional(),
});

/** A monitoring connection's config; `ruler: mimir` names the ruler it pushes to. */
export const monitoringConnectionConfigSchema =
	connectionConfigBase.superRefine((config, ctx) => {
		if (config.ruler === "mimir" && config.rulerUrl === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["rulerUrl"],
				message:
					"ruler mimir pushes each project's rule group to a ruler API: name it in rulerUrl",
			});
		}
	});
export const monitoringConnectionPatchSchema = connectionConfigBase.partial();
export type MonitoringConnectionConfig = z.infer<typeof connectionConfigBase>;

const secretsBase = z.strictObject({
	/** The password of `prometheusUser`; a connection without both is refused MONITORING_SERVER_UNAUTHENTICATED. */
	prometheusPassword: z.string().min(1).max(4096).optional(),
});
export const monitoringConnectionSecretsSchema = secretsBase;
export const monitoringConnectionPatchSecretsSchema = secretsBase.partial();
export type MonitoringConnectionSecrets = z.infer<typeof secretsBase>;

/**
 * What the connection's server can do, read through its own status API (`buildinfo`, `flags`,
 * `config`, `alertmanagers`) on save, on demand and before each binding is taken. `null` is unread:
 * nothing is assumed, and a binding needing what reads null is refused by name.
 */
export interface MonitoringReadiness {
	readAt: string;
	/** Why the status API could not be read through the connection; null where it was. */
	unreadable: string | null;
	/** Whether the server refuses a call without credentials. */
	authenticated: boolean | null;
	version: string | null;
	remoteWriteReceiver: boolean | null;
	lifecycle: boolean | null;
	/** Whether `rule_files` names a file under MONITORING_RULES_DIR. */
	ruleFiles: boolean | null;
	/** Whether the server's config holds Forge's `http_sd_configs` job for each door. */
	discovery: { scrape: boolean; probe: boolean } | null;
	alertmanager: boolean | null;
}

/** `GET /api/integration-connections/:id/monitoring`: the readiness last read and the tokens minted. */
export interface MonitoringConnectionRead {
	connectionId: string;
	ruler: MonitoringRuler;
	readiness: MonitoringReadiness | null;
	tokens: Record<
		MonitoringConnectionTokenKind,
		{ prefix: string; createdAt: string } | null
	>;
}

/** `POST /api/integration-connections/:id/monitoring/tokens/:kind`: the token, shown this once. */
export interface MonitoringTokenResponse {
	token: string;
	prefix: string;
	createdAt: string;
}

/** One step of `GET /api/integration-connections/:id/monitoring/setup`: a change on the server. */
export interface MonitoringSetupStep {
	step: string;
	title: string;
	/** The file the content goes in, or null for flags and commands. */
	file: string | null;
	content: string;
}

/** One Prometheus `http_sd_configs` target group. */
export interface MonitoringTargetGroup {
	targets: string[];
	labels: Record<string, string>;
}

/** `POST /api/projects/:id/monitoring/agent-token`: the token, shown this once. */
export type MonitoringAgentTokenResponse = MonitoringTokenResponse;

/** One alert Prometheus holds for the project. */
export interface MonitoringAlertView {
	name: string;
	state: string;
	activeAt: string | null;
	labels: Record<string, string>;
}

/** `GET /api/projects/:id/monitoring`: what is registered, the rendered rules, the alerts firing. */
export interface MonitoringReadResponse {
	/** Whether the project holds an active monitoring binding, and the ruler its connection names. */
	connected: boolean;
	ruler: MonitoringRuler | null;
	registered: MonitoringConfig | null;
	agentToken: { prefix: string; createdAt: string } | null;
	/** The rule group core renders for the project; null with no rules. */
	rules: string | null;
	/** Whether the backend holds the project's rule group now, read through the connection; null where unread. */
	rulesLoaded: boolean | null;
	/** Null where the project binds no connection, or its Prometheus could not be read. */
	alerts: MonitoringAlertView[] | null;
	/** The connection's server as read now; null where the project binds none. */
	readiness: MonitoringReadiness | null;
	/** What the server cannot do for this binding now, by name: MONITORING_NO_ALERTMANAGER, say. */
	faults: MonitoringFault[];
}

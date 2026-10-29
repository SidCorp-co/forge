/** Header names whose values must be replaced before send. Compared case-insensitively. */
const SCRUB_HEADER_KEYS: ReadonlySet<string> = new Set([
	"authorization",
	"cookie",
	"x-device-token",
	"x-api-key",
	"x-csrf-token",
	// Coolify, GitLab and GitLab webhook credentials, each sent in a header of its own.
	"x-auth-token",
	"private-token",
	"x-gitlab-token",
]);

const SCRUB_BODY_KEYS: ReadonlySet<string> = new Set([
	"authToken",
	"auth_token",
	"apiKey",
	"api_key",
	"password",
	"secret",
	"jwt",
	"token",
	"accessToken",
	"access_token",
	"refreshToken",
	"refresh_token",
	"sessionToken",
	"session_token",
	"bearerToken",
	// Retired by ISS-12, kept for ever: old clients, logs and replays still send it.
	"testCredentials",
	// ISS-1036 — a GitHub App's PEM and a Google service-account key file. Both
	// are credentials with no token-shaped signature of their own, so the key
	// name is the only thing that identifies them in a structured payload.
	"privateKey",
	"private_key",
	"serviceAccountJson",
	"service_account_json",
]);

/** Matches `?token=...` / `?jwt=...` / `?access_token=...` / `?api_key=...` query params. */
const URL_TOKEN_PATTERN =
	/([?&](?:token|jwt|access_token|refresh_token|api_key)=)[^&#]+/gi;

/**
 * ISS-150 — PAT plaintext shape (`forge_pat_<env>_<hex>`). Unanchored and
 * global so we can redact tokens that leak inside larger strings — query
 * params, JSON bodies, breadcrumb messages.
 */
const PAT_STRING_PATTERN = /forge_pat_(?:dev|stg|prd)_[A-Fa-f0-9]+/g;

/**
 * A share link's token (`@forge/contracts/shares:SHARE_TOKEN_PREFIX`): whoever holds it opens the
 * share, so it is redacted wherever it turns up, a `/s/<token>` path included. A cut-off or altered
 * one goes too.
 */
const SHARE_TOKEN_STRING_PATTERN = /forge_share_[A-Za-z0-9_-]{8,}/g;

/**
 * An MCP client's refresh token or authorization code (`@forge/contracts/mcp-auth`): a refresh token
 * mints access tokens for a month, so it is redacted wherever it turns up, cut off or not.
 */
const MCP_OAUTH_SECRET_PATTERN = /forge_mcp_(?:rt|code)_[A-Za-z0-9_-]{8,}/g;

/**
 * A feedback widget visitor's session token or status link token (`@forge/contracts/widget`): the
 * one carries a visitor's chat, the other what they filed, so both are redacted wherever they turn
 * up, a `/api/widget/status/<token>` path included, cut off or not. A site key is public and stays.
 */
const WIDGET_TOKEN_PATTERN = /fw_(?:sess|stat)_[A-Za-z0-9_-]{8,}/g;

const PEM_PRIVATE_KEY_PATTERN =
	/-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/g;

const PEM_PRIVATE_KEY_HEAD_PATTERN =
	/-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----(?:\\n|\s)*(?:[A-Za-z0-9+/=]{16,}(?:(?:\\n|\s)+[A-Za-z0-9+/=]{16,})*)?/g;

/**
 * ISS-1036 — a Google OAuth2 access token, the thing Forge mints from a
 * service-account key. Redacted for the same reason the key is: a token that
 * reaches a log is a live credential for its hour.
 */
const GOOGLE_ACCESS_TOKEN_PATTERN = /ya29\.[A-Za-z0-9_\-.]+/g;

/** A JWT, or the head of one cut off after its first dot: core mints session JWTs. */
const JWT_PATTERN =
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g;

/**
 * A model-provider key's body after `sk-`: a named family (Anthropic, an OpenAI project, service
 * account or admin key) or a plain run of letters and digits, each at least `min` long.
 */
const skKeyBody = (named: number, plain: number) =>
	`sk-(?:(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{${named},}|[A-Za-z0-9]{${plain},}[A-Za-z0-9_-]*)`;

/**
 * Webhook signing secrets, GitHub tokens and model-provider keys, each by its own prefix.
 *
 * ISS-614: `sk-` is a key where it starts a token, not where it ends a word: `task-<hex>`,
 * `desk-…` and `risk-…` are record ids. Glued to the letters or digits before it, `sk-` is read
 * as a key only at 48 characters or more, the shortest real OpenAI key body, which no 24-hex
 * record id, 32-hex uuid or 40-hex sha reaches.
 */
const PREFIXED_TOKEN_PATTERN = new RegExp(
	[
		"whsec_[A-Za-z0-9+/=_-]{8,}",
		"gh[pousr]_[A-Za-z0-9]{20,}",
		"github_pat_[A-Za-z0-9_]{20,}",
		`(?<![A-Za-z0-9])${skKeyBody(16, 20)}`,
		skKeyBody(48, 48),
	].join("|"),
	"g",
);

/** The public scheme a provider key opens with, which a refusal may name without the key. */
const PROVIDER_KEY_LEAD =
	/^(?:whsec_|gh[pousr]_|github_pat_|sk-(?:(?:ant|proj|svcacct|admin)-)?)/;

/**
 * `Bearer <token>`: the scheme stays, the credential goes. A token is told from a word by its shape:
 * a digit, a capital after a small letter, or 24 characters or more. `Bearer credential` is prose.
 */
const BEARER_TOKEN = "[A-Za-z0-9._~+/=-]";
const BEARER_PATTERN = new RegExp(
	`\\b((?:Bearer|bearer|BEARER)\\s+)(?:(?=${BEARER_TOKEN}*(?:\\d|[a-z][A-Z]))${BEARER_TOKEN}{8,}|${BEARER_TOKEN}{24,})`,
	"g",
);

/** A connection URL's password: `scheme://user:password@host` keeps the scheme, user and host. */
const URL_PASSWORD_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi;

/** Shapes that say a secret is there though no value follows to redact: a password label, a
 *  private-key header without its closing dashes, a connection URL with an empty password. */
const SECRET_LABEL_PATTERN =
	/password\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/\S*:\S*@/gi;

const ENV_SECRET_ASSIGNMENT_PATTERN =
	/^(\s*(?:export\s+)?(?:[A-Z0-9]+_)*(?:PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS)(?:_[A-Z0-9]+)*)\s*=\s*\S.*$/;

export const FILTERED = "[Filtered]";

function scrubStringValues(obj: unknown, depth = 0): void {
	if (depth > 8 || !obj) return;
	if (typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const v = obj[i];
			if (typeof v === "string") obj[i] = scrubLogText(v);
			else scrubStringValues(v, depth + 1);
		}
		return;
	}
	const rec = obj as Record<string, unknown>;
	for (const k of Object.keys(rec)) {
		const v = rec[k];
		if (typeof v === "string") rec[k] = scrubLogText(v);
		else scrubStringValues(v, depth + 1);
	}
}

/**
 * Replace every secret-SHAPED run in `s`: a value whose shape identifies it without a key name
 * beside it, so one call covers it wherever it turns up.
 */
function scrubPatInString(s: string): string {
	return s
		.replace(PAT_STRING_PATTERN, FILTERED)
		.replace(SHARE_TOKEN_STRING_PATTERN, FILTERED)
		.replace(MCP_OAUTH_SECRET_PATTERN, FILTERED)
		.replace(WIDGET_TOKEN_PATTERN, FILTERED)
		.replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
		.replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
		.replace(GOOGLE_ACCESS_TOKEN_PATTERN, FILTERED)
		.replace(JWT_PATTERN, FILTERED)
		.replace(PREFIXED_TOKEN_PATTERN, FILTERED)
		.replace(BEARER_PATTERN, `$1${FILTERED}`)
		.replace(URL_PASSWORD_PATTERN, `$1${FILTERED}@`);
}

const isScrubbedKey = (key: string) =>
	SCRUB_BODY_KEYS.has(key) ||
	SCRUB_BODY_KEYS.has(key.toLowerCase()) ||
	SCRUB_HEADER_KEYS.has(key.toLowerCase());

function scrubBodyKeys(obj: unknown, depth = 0): void {
	if (depth > 8 || !obj || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (const item of obj) scrubBodyKeys(item, depth + 1);
		return;
	}
	const rec = obj as Record<string, unknown>;
	for (const key of Object.keys(rec)) {
		if (isScrubbedKey(key)) {
			rec[key] = FILTERED;
			continue;
		}
		scrubBodyKeys(rec[key], depth + 1);
	}
}

function scrubHeaders(
	headers: Record<string, string | string[] | undefined>,
): void {
	for (const k of Object.keys(headers)) {
		if (SCRUB_HEADER_KEYS.has(k.toLowerCase())) {
			headers[k] = FILTERED;
		}
	}
}

/** Returns `url` with token-shaped query params replaced. */
function scrubUrl(url: string): string {
	return url.replace(URL_TOKEN_PATTERN, `$1${FILTERED}`);
}

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// a shorter value is too likely to be ordinary text, so the scrubber does not replace it,
// and a caller that must have a value scrubbed refuses to hand out one this short.
export const SCRUB_MIN_SECRET_LENGTH = 6;

const scrubbable = (secrets: readonly string[]) =>
	secrets.filter(
		(s) => typeof s === "string" && s.length >= SCRUB_MIN_SECRET_LENGTH,
	);

function scrubSecretValues(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of scrubbable(secrets)) {
		out = out.split(s).join(FILTERED);
		const escaped = JSON.stringify(s).slice(1, -1);
		if (escaped !== s) out = out.split(escaped).join(FILTERED);
	}
	return out;
}

const HEADER_RE = new RegExp(
	`\\b(${Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join("|")})(\\s*[:=]\\s*).+`,
	"gi",
);
// the key may close a JSON string (`"apiKey":`) or an escaped one inside JSON text
// (`\\"apiKey\\":`); the value stops at whitespace, a quote, a backslash, a comma, a brace or `&`,
// so `access_token=...&id=7` keeps its `&id=7`.
const FIELD_VALUE = /^\s*\\?"?([^\s"\\,}&]+)/;

/** The marks that close a sentence, a clause or a bracket, as a run at the end of a value. */
const CLOSING_MARKS = /[.;:!?)\]]+$/;

/** A value's body, and the run of closing marks after it. */
function splitClosing(value: string): { body: string; marks: string } {
	const marks = CLOSING_MARKS.exec(value)?.[0] ?? "";
	return { body: value.slice(0, value.length - marks.length), marks };
}

/**
 * What a credential value's scrubbing keeps after it: its closing marks from the first bracket that
 * closes one opened before the value, so `(token: <value>)` keeps its bracket. A bracket closing
 * one the value opened is the value's (`[Filtered]` is scrubbed whole, so scrubbing twice changes
 * nothing), and a full stop or a bang before the kept bracket goes with the value, as it may be the
 * credential's own last character.
 */
function closingKept(value: string): string {
	const { body, marks } = splitClosing(value);
	// a value of closing marks alone is scrubbed whole, as a label cut off before its value is read
	if (body === "") return "";
	let open = 0;
	for (const c of body) {
		if (c === "(" || c === "[") open++;
		else if ((c === ")" || c === "]") && open > 0) open--;
	}
	for (let i = 0; i < marks.length; i++) {
		if (marks[i] !== ")" && marks[i] !== "]") continue;
		if (open === 0) return marks.slice(i);
		open--;
	}
	return "";
}

/**
 * A credential field's value is a credential only in a credential's shape, as a bearer token is: a
 * digit, a capital after a small letter, a character outside a word, or 24 characters or more.
 * `api_key: head` names the header a key rides in; `password: required` is prose. A count of one to
 * three digits and nothing else is prose too (`no token: 4 failures`, ISS-572); four digits is a
 * PIN's length and stays a credential.
 *
 * The marks closing a sentence or a bracket after the value are prose, not part of it: a count may
 * take any (`no token: 4.`, `(secret: 12)`), a word all but `!` and `?`, the symbols a password most
 * often ends in (`password: required.` is prose, `password: Welcome!` is not).
 */
function isOrdinaryWord(value: string): boolean {
	const { body, marks } = splitClosing(value);
	if (/^\d{1,3}$/.test(body)) return true;
	if (/[!?]/.test(marks)) return false;
	return (
		body.length < 24 &&
		/^[A-Za-z]+(?:-[A-Za-z]+)*$/.test(body) &&
		!/[a-z][A-Z]/.test(body)
	);
}

const BODY_RES = Array.from(SCRUB_BODY_KEYS).map(
	(k) =>
		new RegExp(
			`(\\b${escapeRegExp(k)}\\b\\\\?"?\\s*[:=]\\s*\\\\?"?)([^\\s"\\\\,}&]+)`,
			"gi",
		),
);

export function scrubLogText(
	text: string,
	extraSecrets: string[] = [],
): string {
	const headerRe = HEADER_RE;
	const bodyRes = BODY_RES;
	return text
		.replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
		.replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
		.split("\n")
		.map((line) => {
			let out = scrubPatInString(scrubUrl(line));
			out = out.replace(headerRe, `$1$2${FILTERED}`);
			for (const re of bodyRes)
				out = out.replace(re, (whole, field: string, value: string) =>
					isOrdinaryWord(value) ? whole : `${field}${FILTERED}${closingKept(value)}`,
				);
			out = scrubSecretValues(out, extraSecrets);
			out = out.replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${FILTERED}`);
			return out;
		})
		.join("\n");
}

// ingest payloads are parsed JSON, which holds no cycle, so unlike scrubLogRecord this has no
// depth bound: a secret nested past any bound would be stored in plain text.
/**
 * A copy of a parsed JSON payload with the whole scrubber applied at every depth: secret-named keys
 * filtered, every string through scrubLogText, and the caller's known secret values removed from
 * keys and strings alike.
 */
export function scrubSecretsDeep<T>(value: T, knownSecrets: readonly string[] = []): T {
	const known = scrubbable(knownSecrets);
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") return scrubLogText(v, known);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>).map(([k, inner]) => [
					scrubSecretValues(k, known),
					isScrubbedKey(k) && inner !== null && inner !== "" ? FILTERED : walk(inner),
				]),
			);
		}
		return v;
	};
	return walk(value) as T;
}

/** What a span was read as, for a refusal to name. */
export type SecretShape =
	| "private key"
	| "access token"
	| "provider key"
	| "bearer token"
	| "connection password"
	| "credential field"
	| "secret assignment"
	| "secret label";

/** A run of `text` the detector reads as secret, by UTF-16 offset as JavaScript indexes a string. */
export interface SecretSpan {
	/** The offset of its first character. */
	readonly start: number;
	/** The offset one past its last character. */
	readonly end: number;
	readonly shape: SecretShape;
	/** The public scheme it opens with (`sk-proj-`, `ghp_`, `eyJ`), never any of its secret part; `""` where its shape has none. */
	readonly lead: string;
}

interface SpanRule {
	readonly shape: SecretShape;
	readonly pattern: RegExp;
	/** Characters at the match's head the scrubber keeps (a label, a scheme): outside the span. */
	readonly kept?: (m: RegExpExecArray) => number;
	/** Characters at its tail the scrubber keeps. */
	readonly keptTail?: (m: RegExpExecArray) => number;
	readonly lead?: RegExp;
	/** A match this reads as prose is no span: the scrubber leaves it as it stands. */
	readonly prose?: (m: RegExpExecArray, text: string) => boolean;
}

const PEM_LEAD = /^-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/;
const group1 = (m: RegExpExecArray) => m[1]?.length ?? 0;

/** Read over the whole text, as the scrubber reads them before it splits it into lines. */
const TEXT_RULES: readonly SpanRule[] = [
	{ shape: "private key", pattern: PEM_PRIVATE_KEY_PATTERN, lead: PEM_LEAD },
	{ shape: "private key", pattern: PEM_PRIVATE_KEY_HEAD_PATTERN, lead: PEM_LEAD },
];

/** Read line by line, each the pattern `scrubLogText` replaces by, keeping what it keeps. */
const LINE_RULES: readonly SpanRule[] = [
	{ shape: "access token", pattern: URL_TOKEN_PATTERN, kept: group1 },
	{ shape: "access token", pattern: PAT_STRING_PATTERN, lead: /^forge_pat_[a-z]+_/ },
	{ shape: "access token", pattern: SHARE_TOKEN_STRING_PATTERN, lead: /^forge_share_/ },
	{ shape: "access token", pattern: MCP_OAUTH_SECRET_PATTERN, lead: /^forge_mcp_[a-z]+_/ },
	{ shape: "access token", pattern: WIDGET_TOKEN_PATTERN, lead: /^fw_[a-z]+_/ },
	{ shape: "access token", pattern: GOOGLE_ACCESS_TOKEN_PATTERN, lead: /^ya29\./ },
	{ shape: "access token", pattern: JWT_PATTERN, lead: /^eyJ/ },
	{ shape: "provider key", pattern: PREFIXED_TOKEN_PATTERN, lead: PROVIDER_KEY_LEAD },
	{ shape: "bearer token", pattern: BEARER_PATTERN, kept: group1 },
	{ shape: "connection password", pattern: URL_PASSWORD_PATTERN, kept: group1, keptTail: () => 1 },
	{
		shape: "credential field",
		pattern: HEADER_RE,
		kept: (m) => (m[1]?.length ?? 0) + (m[2]?.length ?? 0),
	},
	...BODY_RES.map(
		(pattern): SpanRule => ({
			shape: "credential field",
			pattern,
			kept: group1,
			keptTail: (m) => closingKept(m[2] ?? "").length,
			prose: (m) => isOrdinaryWord(m[2] ?? ""),
		}),
	),
	{
		shape: "secret assignment",
		pattern: new RegExp(ENV_SECRET_ASSIGNMENT_PATTERN.source, "g"),
		kept: (m) => {
			const head = group1(m);
			return head + (/^\s*=\s*/.exec(m[0].slice(head))?.[0].length ?? 0);
		},
	},
];

const LABEL_RULE: SpanRule = {
	shape: "secret label",
	pattern: SECRET_LABEL_PATTERN,
	lead: /^(?:password\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/)/i,
	// a label followed by a word has its value, and the value is prose
	prose: (m, text) => {
		const next = FIELD_VALUE.exec(text.slice(m.index + m[0].length))?.[1];
		return next !== undefined && isOrdinaryWord(next);
	},
};

function spansOf(text: string, offset: number, rules: readonly SpanRule[]): SecretSpan[] {
	const out: SecretSpan[] = [];
	for (const rule of rules) {
		for (const m of text.matchAll(rule.pattern)) {
			if (rule.prose?.(m, text)) continue;
			const start = m.index + (rule.kept?.(m) ?? 0);
			const end = m.index + m[0].length - (rule.keptTail?.(m) ?? 0);
			const value = text.slice(start, end);
			// what the scrubber already redacted is not a secret it would redact again
			if (value === "" || value === FILTERED) continue;
			out.push({
				start: offset + start,
				end: offset + end,
				shape: rule.shape,
				lead: rule.lead?.exec(value)?.[0] ?? "",
			});
		}
	}
	return out;
}

/**
 * Every run of `text` the detector reads as secret, in order, a span inside another left out. The
 * patterns are those `scrubLogText` redacts by, so it names a span wherever the scrubber would change
 * the text. A label whose value was cut off (`password:` with nothing after it) is a span of its own
 * where no value span covers it.
 */
export function secretSpans(text: string): SecretSpan[] {
	const values = spansOf(text, 0, TEXT_RULES);
	let offset = 0;
	for (const line of text.split("\n")) {
		values.push(...spansOf(line, offset, LINE_RULES));
		offset += line.length + 1;
	}
	const labels = spansOf(text, 0, [LABEL_RULE]).filter(
		(l) => !values.some((v) => v.start < l.end && l.start < v.end),
	);
	const ordered = [...values, ...labels].sort((a, b) => a.start - b.start || b.end - a.end);
	const out: SecretSpan[] = [];
	for (const span of ordered) {
		const last = out[out.length - 1];
		if (last && span.end <= last.end) continue;
		out.push(span);
	}
	return out;
}

/** Whether `text` carries anything the scrubber would redact, or a label that says a secret is
 *  there with its value cut off. The one detector a content check refuses by. */
export function containsSecret(text: string): boolean {
	return secretSpans(text).length > 0;
}

// a log record is the caller's own object, so it is copied rather than mutated; a class
// instance (an Error, a Date, a Buffer) is kept as it is for its serializer, which scrubs its text.
/** A copy of a structured log record with secret-named keys filtered and every string scrubbed. */
export function scrubLogRecord<T>(value: T, depth = 0): T {
	if (typeof value === "string") return scrubLogText(value) as T;
	if (!value || typeof value !== "object" || depth > 8) return value;
	if (Array.isArray(value))
		return value.map((v) => scrubLogRecord(v, depth + 1)) as T;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>))
		out[k] = isScrubbedKey(k) ? FILTERED : scrubLogRecord(v, depth + 1);
	return out as T;
}

/**
 * Scrub a Sentry event in place: request headers, URL and body, breadcrumbs, the message, every
 * exception value, and `extra` and `contexts`.
 * Generic over the event shape so this works across @sentry/react,
 * @sentry/node, and @sentry/nextjs.
 */
export function scrubSentryEvent<E extends SentryLikeEvent>(event: E): E {
	const req = event.request;
	if (req?.headers) scrubHeaders(req.headers);
	if (req?.url) req.url = scrubPatInString(scrubUrl(req.url));
	if (req?.data !== undefined && req.data !== null) {
		if (typeof req.data === "string") {
			const rawData = req.data;
			try {
				const parsed = JSON.parse(rawData);
				scrubBodyKeys(parsed);
				scrubStringValues(parsed);
				req.data = JSON.stringify(parsed);
			} catch {
				// not JSON — still scan for raw PAT plaintext.
				req.data = scrubPatInString(rawData);
			}
		} else {
			scrubBodyKeys(req.data);
			scrubStringValues(req.data);
		}
	}
	if (typeof event.message === "string")
		event.message = scrubLogText(event.message);
	if (event.logentry) {
		if (typeof event.logentry.message === "string")
			event.logentry.message = scrubLogText(event.logentry.message);
		if (typeof event.logentry.formatted === "string")
			event.logentry.formatted = scrubLogText(event.logentry.formatted);
	}
	for (const ex of event.exception?.values ?? []) {
		if (typeof ex.value === "string") ex.value = scrubLogText(ex.value);
	}
	for (const bag of [event.extra, event.contexts]) {
		scrubBodyKeys(bag);
		scrubStringValues(bag);
	}
	if (event.breadcrumbs) {
		for (const b of event.breadcrumbs) {
			if (typeof b.message === "string") b.message = scrubLogText(b.message);
			if (b.data && typeof b.data === "object") {
				const d = b.data as Record<string, unknown>;
				if (typeof d.url === "string")
					d.url = scrubPatInString(scrubUrl(d.url));
				scrubBodyKeys(d);
				scrubStringValues(d);
			}
		}
	}
	return event;
}

interface SentryLikeEvent {
	request?: {
		headers?: Record<string, string | string[] | undefined>;
		url?: string;
		data?: unknown;
	};
	breadcrumbs?: Array<{ message?: string; data?: unknown }>;
	message?: unknown;
	logentry?: { message?: unknown; formatted?: unknown };
	exception?: { values?: Array<{ value?: unknown }> };
	extra?: unknown;
	contexts?: unknown;
}

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** The commit a build was told it was made from, or `null` for anything that is not one. */
export function parseSourceCommit(raw: string | undefined): string | null {
	const value = raw?.trim();
	return value && SOURCE_COMMIT_PATTERN.test(value) ? value : null;
}

export {
	redactionCount,
	scrubEmails,
	scrubPersonalData,
} from "./personal-data.js";

export {
	errorsWithin,
	REDACTED,
	redactedMessage,
	redactQueryParams,
} from "./query-params.js";

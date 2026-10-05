/** Header names whose values must be replaced before send. Compared case-insensitively. */
const SCRUB_HEADER_KEYS: ReadonlySet<string> = new Set([
	"authorization",
	"cookie",
	"x-device-token",
	"x-api-key",
	"x-csrf-token",
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

/** Webhook signing secrets, GitHub tokens and model-provider keys, each by its own prefix. */
const PREFIXED_TOKEN_PATTERN =
	/whsec_[A-Za-z0-9+/=_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant|proj)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}[A-Za-z0-9_-]*/g;

/** `Bearer <token>`: the scheme stays, the credential goes. */
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** A connection URL's password: `scheme://user:password@host` keeps the scheme, user and host. */
const URL_PASSWORD_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi;

/** Shapes that say a secret is there though no value follows to redact: a password label, a
 *  private-key header without its closing dashes, a connection URL with an empty password. */
const SECRET_LABEL_PATTERN =
	/password\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/\S*:\S*@/i;

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

// cm:why a shorter value is too likely to be ordinary text, so the scrubber does not replace it,
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

// cm:why unlike scrubStringValues this has no depth bound: a known value nested past any bound
// would leave in plain text, and its input is parsed JSON, which holds no cycle.
export function scrubSecretValuesDeep<T>(
	value: T,
	secrets: readonly string[],
): T {
	const known = scrubbable(secrets);
	if (known.length === 0) return value;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") return scrubSecretValues(v, known);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>).map(([k, inner]) => [
					scrubSecretValues(k, known),
					walk(inner),
				]),
			);
		}
		return v;
	};
	return walk(value) as T;
}

const HEADER_RE = new RegExp(
	`\\b(${Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join("|")})(\\s*[:=]\\s*).+`,
	"gi",
);
// cm:why the key may close a JSON string (`"apiKey":`) or an escaped one inside JSON text
// (`\\"apiKey\\":`); the value stops at whitespace, a quote, a backslash, a comma, a brace or `&`,
// so `access_token=...&id=7` keeps its `&id=7`.
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
			for (const re of bodyRes) out = out.replace(re, `$1${FILTERED}`);
			out = scrubSecretValues(out, extraSecrets);
			out = out.replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${FILTERED}`);
			return out;
		})
		.join("\n");
}

/** Whether `text` carries anything the scrubber would redact, or a label that says a secret is
 *  there with its value cut off. The one detector a content check refuses by. */
export function containsSecret(text: string): boolean {
	return scrubLogText(text) !== text || SECRET_LABEL_PATTERN.test(text);
}

// cm:why a log record is the caller's own object, so it is copied rather than mutated; a class
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
	scrubPersonalData,
} from "./personal-data.js";

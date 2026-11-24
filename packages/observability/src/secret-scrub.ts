// The secret filter: what scrubs a log line, a structured record, an ingest payload and a Sentry
// event, by the shapes secret-patterns.ts declares.

import {
	BEARER_PATTERN,
	BODY_RES,
	PROSE_LABEL_FIELD,
	ENV_SECRET_ASSIGNMENT_PATTERN,
	escapeRegExp,
	FEEDBACK_SERVER_KEY_PATTERN,
	FIELD_VALUE,
	FILTERED,
	GOOGLE_ACCESS_TOKEN_PATTERN,
	HEADER_RE,
	isScrubbedKey,
	JWT_PATTERN,
	MCP_OAUTH_SECRET_PATTERN,
	PAT_STRING_PATTERN,
	PEM_PRIVATE_KEY_HEAD_PATTERN,
	PEM_PRIVATE_KEY_PATTERN,
	PREFIXED_TOKEN_PATTERN,
	SCRUB_HEADER_KEYS,
	SHARE_TOKEN_STRING_PATTERN,
	URL_PASSWORD_PATTERN,
	URL_TOKEN_PATTERN,
	WIDGET_TOKEN_PATTERN,
} from "./secret-patterns.js";

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
		.replace(FEEDBACK_SERVER_KEY_PATTERN, FILTERED)
		.replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
		.replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
		.replace(GOOGLE_ACCESS_TOKEN_PATTERN, FILTERED)
		.replace(JWT_PATTERN, FILTERED)
		.replace(PREFIXED_TOKEN_PATTERN, FILTERED)
		.replace(BEARER_PATTERN, `$1${FILTERED}`)
		.replace(URL_PASSWORD_PATTERN, `$1${FILTERED}@`);
}

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

/** The marks that close a sentence, a clause or a bracket, as a run at the end of a value. */
const CLOSING_MARKS = /[.;:!?)\]]+$/;

/** A value's body, and the run of closing marks after it. */
function splitClosing(value: string): { body: string; marks: string } {
	const marks = CLOSING_MARKS.exec(value)?.[0] ?? "";
	return { body: value.slice(0, value.length - marks.length), marks };
}

/**
 * What a credential value's scrubbing keeps after it: the closing marks that end the sentence, the
 * clause or a bracket around it, so `password: <value>.` keeps its full stop and `(token: <value>)`
 * its bracket (ISS-757). A bang or a question mark goes with the value, with every mark before it, as
 * they are the symbols a password most often ends in; a bracket closing one the value opened is the
 * value's (`[Filtered]` is scrubbed whole, so scrubbing twice changes nothing).
 */
export function closingKept(value: string): string {
	const { body, marks } = splitClosing(value);
	// a value of closing marks alone is scrubbed whole, as a label cut off before its value is read
	if (body === "") return "";
	let open = 0;
	for (const c of body) {
		if (c === "(" || c === "[") open++;
		else if ((c === ")" || c === "]") && open > 0) open--;
	}
	let kept = 0;
	for (let i = 0; i < marks.length; i++) {
		const c = marks[i];
		if (c === "!" || c === "?") kept = i + 1;
		else if ((c === ")" || c === "]") && open > 0) {
			open--;
			kept = i + 1;
		}
	}
	return marks.slice(kept);
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
export function isOrdinaryWord(value: string, anyLetters = false): boolean {
	const { body, marks } = splitClosing(value);
	if (/^\d{1,3}$/.test(body)) return true;
	if (/[!?]/.test(marks)) return false;
	// a prose label (ISS-1458) takes a word of any script's letters and marks, `lỗi`, `chưa`
	const word = anyLetters ? /^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*$/u : /^[A-Za-z]+(?:-[A-Za-z]+)*$/;
	return (
		body.length < 24 &&
		word.test(body) &&
		!/[a-z][A-Z]/.test(body)
	);
}

/**
 * Whether the rest of a credential header's line is prose rather than its value: the run after the
 * separator is an ordinary word by the credential-field shape test (`isOrdinaryWord`), and so is the
 * run after it where that first word may be an auth scheme (`Bearer`, `Basic`). "The Authorization:
 * Bearer header, read at src/auth/guard.ts:42" names where a credential travels; "Authorization:
 * Bearer eyJ…" or "Cookie: sid=…" carries one, and its whole line stays redacted, as a header's value
 * may run on in parts (ISS-757).
 */
export function headerValueIsProse(rest: string): boolean {
	const first = FIELD_VALUE.exec(rest);
	if (!first?.[1]) return true;
	if (!isOrdinaryWord(first[1])) return false;
	const after = rest.slice(first[0].length);
	if (!/^\s/.test(after)) return true;
	const second = FIELD_VALUE.exec(after)?.[1];
	return second === undefined || isOrdinaryWord(second);
}

/** `line` with the rest of it from the first credential header carrying a value redacted. */
function scrubHeaderValue(line: string, headerRe: RegExp): string {
	for (const m of line.matchAll(headerRe)) {
		if (!headerValueIsProse(m[3] ?? "")) return `${line.slice(0, m.index + m[0].length)}${FILTERED}`;
	}
	return line;
}

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
			out = scrubHeaderValue(out, headerRe);
			for (const re of bodyRes)
				out = out.replace(re, (whole, field: string, value: string) =>
					isOrdinaryWord(value, PROSE_LABEL_FIELD.test(field)) ? whole : `${field}${FILTERED}${closingKept(value)}`,
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

const CREDENTIAL_HEADER_NAME = new RegExp(
	`(?:^|-)(?:${Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join("|")})$`,
	"i",
);

/**
 * Whether a header of this name carries a credential whatever it holds: a scrubbed header's name,
 * alone or as the last part of one (`Proxy-Authorization`). Read by name, not by its value, since a
 * request that is kept or replayed must never hold one at all.
 */
export function isCredentialHeader(name: string): boolean {
	return CREDENTIAL_HEADER_NAME.test(name.trim());
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

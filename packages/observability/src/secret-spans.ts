// The secret detector: every span of a text the scrubber (secret-scrub.ts) would redact, named by
// its shape, for a content check to refuse by.

import {
	BEARER_PATTERN,
	BODY_RES,
	PROSE_LABEL_FIELD,
	ENV_SECRET_ASSIGNMENT_PATTERN,
	FEEDBACK_SERVER_KEY_PATTERN,
	FIELD_VALUE,
	FILTERED,
	GOOGLE_ACCESS_TOKEN_PATTERN,
	HEADER_RE,
	JWT_PATTERN,
	MCP_OAUTH_SECRET_PATTERN,
	PAT_STRING_PATTERN,
	PEM_PRIVATE_KEY_HEAD_PATTERN,
	PEM_PRIVATE_KEY_PATTERN,
	PREFIXED_TOKEN_PATTERN,
	PROVIDER_KEY_LEAD,
	SECRET_LABEL_PATTERN,
	SHARE_TOKEN_STRING_PATTERN,
	URL_PASSWORD_PATTERN,
	URL_TOKEN_PATTERN,
	WIDGET_TOKEN_PATTERN,
} from "./secret-patterns.js";
import { closingKept, headerValueIsProse, isOrdinaryWord } from "./secret-scrub.js";

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
	/** How far the match reaches where its pattern reads part of it ahead, as `m[0]` leaves it out. */
	readonly length?: (m: RegExpExecArray) => number;
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
	{ shape: "access token", pattern: FEEDBACK_SERVER_KEY_PATTERN, lead: /^fsk_/ },
	{ shape: "access token", pattern: GOOGLE_ACCESS_TOKEN_PATTERN, lead: /^ya29\./ },
	{ shape: "access token", pattern: JWT_PATTERN, lead: /^eyJ/ },
	{ shape: "provider key", pattern: PREFIXED_TOKEN_PATTERN, lead: PROVIDER_KEY_LEAD },
	{ shape: "bearer token", pattern: BEARER_PATTERN, kept: group1 },
	{ shape: "connection password", pattern: URL_PASSWORD_PATTERN, kept: group1, keptTail: () => 1 },
	{
		shape: "credential field",
		pattern: HEADER_RE,
		kept: (m) => (m[1]?.length ?? 0) + (m[2]?.length ?? 0),
		length: (m) => m[0].length + (m[3]?.length ?? 0),
		prose: (m) => headerValueIsProse(m[3] ?? ""),
	},
	...BODY_RES.map(
		(pattern): SpanRule => ({
			shape: "credential field",
			pattern,
			kept: group1,
			keptTail: (m) => closingKept(m[2] ?? "").length,
			prose: (m) => isOrdinaryWord(m[2] ?? "", PROSE_LABEL_FIELD.test(m[1] ?? "")),
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
	lead: /^(?:password\s*[:=]|m[ậa]t kh[ẩa]u\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/)/i, // i18n-allow: the Vietnamese password label
	// a label followed by a word has its value, and the value is prose
	prose: (m, text) => {
		const next = FIELD_VALUE.exec(text.slice(m.index + m[0].length))?.[1];
		return next !== undefined && isOrdinaryWord(next, PROSE_LABEL_FIELD.test(m[0]));
	},
};

function spansOf(text: string, offset: number, rules: readonly SpanRule[]): SecretSpan[] {
	const out: SecretSpan[] = [];
	for (const rule of rules) {
		for (const m of text.matchAll(rule.pattern)) {
			if (rule.prose?.(m, text)) continue;
			const start = m.index + (rule.kept?.(m) ?? 0);
			const end = m.index + (rule.length?.(m) ?? m[0].length) - (rule.keptTail?.(m) ?? 0);
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

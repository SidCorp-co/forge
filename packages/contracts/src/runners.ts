// The codes a runner binding is refused by, in the refusal envelope.

export const RUNNER_REFUSAL_CODES = [
	"RUNNER_REFUSED",
	"RUNNER_ALREADY_BOUND",
	"DEVICE_BIND_FORBIDDEN",
] as const;

export type RunnerRefusalCode = (typeof RUNNER_REFUSAL_CODES)[number];

/**
 * Detect a Claude CLI usage limit. Specific patterns that include the reset
 * phrase avoid false positives from agent responses that merely *discuss*
 * usage limits. Also matches the runner's explicit `[USAGE_LIMIT]` token.
 */
export function isUsageLimitError(text: string): boolean {
	if (!text) return false;
	const lower = text.toLowerCase();
	if (text.includes("[USAGE_LIMIT]")) return true;
	// CLI includes "resets ..." after the limit message. The reset value can be a
	// bare time ("resets 11am") or a dated time ("resets Jun 4, 11am"), and the
	// limit phrase may carry a qualifier ("your weekly limit", "your 5-hour limit").
	const resetsValue = String.raw`resets\s+(?:[A-Za-z]+\s+)?\d`;
	if (new RegExp(String.raw`you've hit your(?:\s+[\w-]+)?\s+limit.*${resetsValue}`, "i").test(text)) {
		return true;
	}
	if (new RegExp(`out of extra usage.*${resetsValue}`, "i").test(text)) return true;
	// Fallback: short error-only text (not a full agent response) → loose match.
	if (
		text.length < 300 &&
		(lower.includes("out of extra usage") || /you've hit your(?:\s+[\w-]+)?\s+limit/i.test(text))
	) {
		return true;
	}
	return false;
}

export function isSpendLimitError(text: string): boolean {
	if (!text) return false;
	if (text.length >= 300) return false;
	return /\bspend[\s-]?limit\b/i.test(text) && (/\bhit your\b/i.test(text) || /\bmonthly\b/i.test(text));
}

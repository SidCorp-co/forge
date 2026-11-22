export {
	escapeRegExp,
	FILTERED,
} from "./secret-patterns.js";

export {
	closingKept,
	isCredentialHeader,
	SCRUB_MIN_SECRET_LENGTH,
	scrubLogRecord,
	scrubLogText,
	scrubSecretsDeep,
	scrubSentryEvent,
} from "./secret-scrub.js";

export {
	containsSecret,
	type SecretShape,
	type SecretSpan,
	secretSpans,
} from "./secret-spans.js";

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

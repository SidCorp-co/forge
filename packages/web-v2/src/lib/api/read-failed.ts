import { formatApiError } from "./error";

/**
 * What a failed read says: what could not be read, then why — "Forge could not be reached. Check
 * your connection, then try again." where the browser could not reach Forge, the refusal's own
 * sentence otherwise (ISS-1228 round 22). A read-failure line that names only what is missing leaves
 * a person whose connection dropped not knowing that is why.
 */
export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

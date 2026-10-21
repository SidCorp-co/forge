import { ApiError } from "./client";
import { formatApiError } from "./error";

export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

/** Whether a failed read's line offers Retry: always, whatever the failure, except a 401, which
 *  signs the person out (ISS-1228). A refusal that says to try again must carry the way to. */
export function offersRetry(error: unknown): boolean {
	return !(error instanceof ApiError && error.status === 401);
}

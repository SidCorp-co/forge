import { ApiError } from "./client";
import { formatApiError } from "./error";

export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

/** Every failed read offers Retry but a 401's, which signs the person out (ISS-1228). */
export function offersRetry(error: unknown): boolean {
	return !(error instanceof ApiError && error.status === 401);
}

import { formatApiError } from "./error";

export function couldNotRead(what: string, error: unknown): string {
	return `${what} could not be read. ${formatApiError(error)}`;
}

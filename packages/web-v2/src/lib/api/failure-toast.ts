// A 4xx refusal is titled by what did not happen; "Request failed" is kept for a fault (ISS-1229 r24).

import { formatApiError } from "./error";
import { ApiError } from "./client";

export const FAULT_TITLE = "Request failed";

export function failureToast(
  err: unknown,
  notDone: string,
  description: string = formatApiError(err),
): { title: string; description: string; tone: "error" } {
  const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
  return { title: refused ? notDone : FAULT_TITLE, description, tone: "error" };
}

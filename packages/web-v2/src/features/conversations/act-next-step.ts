// What a person does next when an act pressed in the chat fails (REQ-69 BC-5): read off the refusal's
// status and code, never parsed out of its prose. The refusal itself says why; this says what next.

import { ApiError } from "@/lib/api/client";

/** forbidden: someone else may do it. moved: the item changed since the offer. fix: the request was refused as sent. retry: the server or network failed. */
export type ActNextStep = "forbidden" | "moved" | "fix" | "retry";

const MOVED_CODE = /STALE|STATE|ALREADY|MOVED|CONFLICT|NOT_FROM|TRANSITION|WITHDRAWN|OPEN_QUESTIONS/;
const FORBIDDEN_CODE = /FORBIDDEN|PERMISSION|NOT_SIGNER|ADMIN_ONLY|UNAUTHENTICATED/;

export function nextStepOf(err: unknown): ActNextStep {
  if (!(err instanceof ApiError)) return "retry";
  const code = err.code ?? "";
  if (err.status === 401 || err.status === 403 || FORBIDDEN_CODE.test(code)) return "forbidden";
  if (err.status === 409 || MOVED_CODE.test(code)) return "moved";
  if (err.status >= 500) return "retry";
  return "fix";
}

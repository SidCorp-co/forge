import { ApiError } from "@/lib/api/client";

// cm:edge contract -> packages/core/src/middleware/require-fresh-auth.ts — that gate is the only producer of this code, and it answers 403 with `FRESH_AUTH_REQUIRED`; a surface that calls a gated route without recognising it can only show the raw message, which names a state the user has no control to leave.
export function isFreshAuthError(err: unknown): boolean {
	return err instanceof ApiError && (err.code === "FRESH_AUTH_REQUIRED" || err.status === 403);
}

import { ApiError } from "@/lib/api/client";

export function isFreshAuthError(err: unknown): boolean {
	return err instanceof ApiError && (err.code === "FRESH_AUTH_REQUIRED" || err.status === 403);
}

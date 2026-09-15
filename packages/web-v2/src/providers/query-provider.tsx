"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";

export const QUERY_MAX_RETRIES = 2;

/**
 * Retry a failed query twice, unless the server already said the request itself
 * was wrong.
 */
// cm:guard a 4xx is the server saying the REQUEST is wrong — unauthenticated, forbidden, not found, malformed — and asking again unchanged cannot make it right. Retrying them tripled every such failure and tripled how long the screen took to show the error it was always going to show (ISS-1019).
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
	if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
	return failureCount < QUERY_MAX_RETRIES;
}

/**
 * The project's query defaults, in one place so the test that asserts them
 * asserts the same object the app runs on rather than a copy of it.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 60_000,
				gcTime: 300_000,
				retry: shouldRetryQuery,
				// cm:guard false is this project's default and the exemption is stated at the query that needs it, `useActivity` in features/activity/hooks.ts. Flipping this back makes every screen refetch everything each time the tab regains focus, which is what it did (ISS-1019).
				refetchOnWindowFocus: false,
			},
		},
	});
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createQueryClient);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

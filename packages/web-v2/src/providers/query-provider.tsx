"use client";

import { useState } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NEEDS_YOU_ROOT } from "@/features/needs-you/hooks";
import { ApiError } from "@/lib/api/client";

export const QUERY_MAX_RETRIES = 2;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
	if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
	return failureCount < QUERY_MAX_RETRIES;
}

/**
 * The project's query defaults, in one place so the test that asserts them
 * asserts the same object the app runs on rather than a copy of it.
 */
// cm:why any write can change whose turn a row is, so every settled mutation re-reads the waiting-on-you
// counts; the menu would otherwise keep a number its list no longer agrees with (REQ-11 BC-10)
export function createQueryClient(): QueryClient {
	const client: QueryClient = new QueryClient({
		mutationCache: new MutationCache({
			onSettled: () => client.invalidateQueries({ queryKey: NEEDS_YOU_ROOT }),
		}),
		defaultOptions: {
			queries: {
				staleTime: 60_000,
				gcTime: 300_000,
				retry: shouldRetryQuery,
				refetchOnWindowFocus: false,
			},
		},
	});
	return client;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createQueryClient);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

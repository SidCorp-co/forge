"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 60_000,
				gcTime: 300_000,
				retry: shouldRetryQuery,
				refetchOnWindowFocus: false,
			},
		},
	});
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createQueryClient);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

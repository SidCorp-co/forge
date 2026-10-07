"use client";

import type { ContentLanguageView } from "@forge/contracts/content-language";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";

// A project's content language (contracts `content-language.ts`), read by its settings field and by
// every surface that writes copy in it, such as the ETA column.

const path = (projectId: string) => `/projects/${projectId}/content-language`;

export const contentLanguageApi = {
	get: (projectId: string) => apiClient<ContentLanguageView>(path(projectId)),
};

export const contentLanguageKey = (projectId: string | undefined) => ["project", projectId, "content-language"] as const;

export function useContentLanguage(projectId: string | undefined) {
	return useQuery({
		queryKey: contentLanguageKey(projectId),
		queryFn: () => contentLanguageApi.get(projectId as string),
		enabled: Boolean(projectId),
		retry: false,
	});
}

"use client";

import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContentLanguageView, ContentLanguageWrite } from "@forge/contracts/content-language";
import { apiClient } from "@/lib/api/client";

const path = (projectId: string) => `/projects/${projectId}/content-language`;

const contentLanguageApi = {
	get: (projectId: string) => apiClient<ContentLanguageView>(path(projectId)),
	put: (projectId: string, write: ContentLanguageWrite) =>
		apiClient<ContentLanguageView>(path(projectId), { method: "PUT", body: JSON.stringify(write) }),
};

const key = (projectId: string | undefined) => ["project", projectId, "content-language"] as const;

export function useContentLanguage(projectId: string | undefined) {
	return useQuery({
		queryKey: key(projectId),
		queryFn: () => contentLanguageApi.get(projectId as string),
		enabled: Boolean(projectId),
		retry: false,
	});
}

/** The value lives in the project document, so a write moves its revision for every reader of it. */
export function useWriteContentLanguage(projectId: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (write: ContentLanguageWrite) => contentLanguageApi.put(projectId as string, write),
		onSuccess: (saved) => {
			qc.setQueryData(key(projectId), saved);
			qc.invalidateQueries({ queryKey: ["project", projectId, "config"] });
			qc.invalidateQueries({ queryKey: ["project", projectId, "config-effective"] });
			toast({ title: `Content language saved at revision ${saved.revision}`, tone: "success" });
		},
	});
}

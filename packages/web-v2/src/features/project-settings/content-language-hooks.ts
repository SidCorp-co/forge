"use client";

import { useToast } from "@/providers/toast-provider";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ContentLanguageWrite } from "@forge/contracts/content-language";
import { contentLanguageApi, contentLanguageKey } from "@/lib/api/content-language";

/** The value lives in the project document, so a write moves its revision for every reader of it. */
export function useWriteContentLanguage(projectId: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (write: ContentLanguageWrite) => contentLanguageApi.put(projectId as string, write),
		onSuccess: (saved) => {
			qc.setQueryData(contentLanguageKey(projectId), saved);
			qc.invalidateQueries({ queryKey: ["project", projectId, "config"] });
			qc.invalidateQueries({ queryKey: ["project", projectId, "config-effective"] });
			toast({ title: `Content language saved at revision ${saved.revision}`, tone: "success" });
		},
	});
}

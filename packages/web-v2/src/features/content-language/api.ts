import { apiClient } from "@/lib/api/client";
import type { ContentLanguageView, ContentLanguageWrite } from "./types";

const path = (projectId: string) => `/projects/${projectId}/content-language`;

export const contentLanguageApi = {
	get: (projectId: string) => apiClient<ContentLanguageView>(path(projectId)),
	put: (projectId: string, write: ContentLanguageWrite) =>
		apiClient<ContentLanguageView>(path(projectId), { method: "PUT", body: JSON.stringify(write) }),
};

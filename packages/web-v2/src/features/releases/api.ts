
import { apiClient } from "@/lib/api/client";
import type { ReleaseRunState } from "./types";

export const releasesApi = {
	getRunState: (projectId: string, runId: string) =>
		apiClient<ReleaseRunState>(
			`/projects/${projectId}/release-batches/${runId}/state`,
		),
};

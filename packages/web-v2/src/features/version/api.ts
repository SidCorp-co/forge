import { apiClient } from "@/lib/api/client";

export interface DeploymentVersion {
	version: string;
	sourceCommit: string | null;
	uptimeSeconds: number;
}

export const versionApi = {
	/** `GET /api/version` — the deployment answering this page, not this bundle. */
	get: () => apiClient<DeploymentVersion>("/version"),
};

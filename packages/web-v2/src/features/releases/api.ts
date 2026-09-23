
import { apiClient } from "@/lib/api/client";
import { parseReleaseRoster } from "./roster";
import type { ReleaseRunState } from "./types";

export const releasesApi = {
	/** Only `roster` is parsed: the rest of the state is cast as before. */
	getRunState: async (projectId: string, runId: string) => {
		const endpoint = `/projects/${projectId}/release-batches/${runId}/state`;
		const state = await apiClient<ReleaseRunState>(endpoint);
		return { ...state, roster: parseReleaseRoster(state.roster, endpoint) };
	},
};

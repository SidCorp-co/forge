// web-v2 feature module: releases — REST surface, verified against
// `packages/core/src/release-batch/routes.ts`.
//
// One read and nothing else. The writes on that router — announcing a method,
// opening an attempt, recording an account — belong to the agent running the
// release and are reached with its own token, so no button here sends them: a
// person pressing "deployed" would be writing the agent's half of a record
// whose whole point is that the two halves have separate authors.

import { apiClient } from "@/lib/api/client";
import type { ReleaseRunState } from "./types";

export const releasesApi = {
	/**
	 * `GET /api/projects/:projectId/release-batches/:runId/state` — the roster,
	 * the ledger, a live probe reading taken at request time, and the bounds.
	 * `viewer` and up.
	 */
	getRunState: (projectId: string, runId: string) =>
		apiClient<ReleaseRunState>(
			`/projects/${projectId}/release-batches/${runId}/state`,
		),
};

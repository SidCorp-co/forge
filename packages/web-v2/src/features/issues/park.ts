
// The park an issue stands at, read once: the issue page takes its thread question from here. A park
// offers a person no move of its own (REQ-68 BC-6): the master resumes it, and its question is
// answered in Needs you, on the item the issue serves.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { issueKeySegment } from "@/lib/api/ref-bridge";
import type { ParkReading } from "./derive";
import { issueDetailApi } from "./detail-api";
import type { IssueStatus } from "./types";

/**
 * Keyed under the issue's comments, so a park record posted after the move is read when the thread
 * refreshes. It is read with the page's first reads, before the issue's status is known; a later
 * move of the status reads it again, so a move reads the park it lands in.
 */
const parkQueryKey = (issueId: string | undefined, projectId: string | undefined) =>
	["comments", issueKeySegment(issueId, projectId), "park"] as const;

/** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
export function useIssuePark(
	issueId: string | undefined,
	status: IssueStatus | undefined,
	projectId?: string,
): ParkReading {
	const qc = useQueryClient();
	const key = parkQueryKey(issueId, projectId);
	const keyText = JSON.stringify(key);
	const q = useQuery({ queryKey: key, queryFn: () => issueDetailApi.getPark(issueId as string, projectId), enabled: Boolean(issueId) });
	// a status move on the same issue is a new reading of its park
	const readAtRef = useRef({ keyText, status });
	useEffect(() => {
		const prior = readAtRef.current;
		readAtRef.current = { keyText, status };
		if (prior.keyText === keyText && prior.status !== undefined && status !== undefined && prior.status !== status) {
			void qc.invalidateQueries({ queryKey: JSON.parse(keyText) as readonly unknown[], exact: true });
		}
	}, [keyText, status, qc]);
	if (q.isError) return { state: "error" };
	if (q.isPending || !q.data) return { state: "loading" };
	return { state: "ready", park: q.data.park };
}

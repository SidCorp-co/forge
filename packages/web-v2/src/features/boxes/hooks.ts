import type { BoxRecord, OpenBoxRequest } from "@forge/contracts/boxes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boxesApi } from "./api";
import { boxKeys, boxQueries } from "./queries";

export const useProjectBoxes = (projectId: string) => useQuery(boxQueries.project(projectId));
export const useBox = (boxId: string) => useQuery(boxQueries.one(boxId));
export const useBoxActs = (boxId: string) => useQuery(boxQueries.acts(boxId));
export const useBoxSpans = (boxId: string) => useQuery(boxQueries.spans(boxId));
export const useBoxIssueLabel = (issueId: string | null) => useQuery({ ...boxQueries.issueLabel(issueId ?? ""), enabled: !!issueId });

/** A move on one box: the answer replaces the box in the project's list and in its own read at once, and the list is read again. */
function useBoxMove(projectId: string, move: (id: string) => Promise<BoxRecord>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: move,
    onSuccess: (box) => {
      qc.setQueryData<BoxRecord[]>(boxKeys.project(projectId), (list) => list?.map((b) => (b.id === box.id ? box : b)));
      qc.setQueryData<BoxRecord>(boxKeys.one(box.id), (one) => (one ? box : one));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: boxKeys.project(projectId) }),
  });
}

export const useTakeBox = (projectId: string) => useBoxMove(projectId, boxesApi.take);
export const useReleaseBox = (projectId: string) => useBoxMove(projectId, boxesApi.release);
export const useCloseBox = (projectId: string) => useBoxMove(projectId, boxesApi.close);
export const useStartRecording = (projectId: string) => useBoxMove(projectId, (id) => boxesApi.recording(id, true));
export const useStopRecording = (projectId: string) => useBoxMove(projectId, (id) => boxesApi.recording(id, false));

export function useOpenBox(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: OpenBoxRequest) => boxesApi.open(projectId, request),
    onSettled: () => qc.invalidateQueries({ queryKey: boxKeys.project(projectId) }),
  });
}

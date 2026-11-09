import type { ChannelCommonIssueWrite, ChannelMemberWrite } from "@forge/contracts/support-channel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { channelsApi } from "./api";

const KEY = "channels";

export function useChannels(projectId: string) {
  return useQuery({ queryKey: [KEY, projectId], queryFn: () => channelsApi.list(projectId), refetchInterval: 30_000 });
}

export function useChannel(projectId: string, rid: string) {
  return useQuery({ queryKey: [KEY, projectId, rid], queryFn: () => channelsApi.one(projectId, rid), refetchInterval: 30_000 });
}

/** A person's correction of a member, confirmed (REQ-75 r6 BC-33). */
export function useConfirmMember(projectId: string, rid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; write: ChannelMemberWrite }) =>
      channelsApi.confirmMember(projectId, rid, input.username, input.write),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, projectId] }),
  });
}

/** A rule a person adds to the channel's record. */
export function useAddRule(projectId: string, rid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => channelsApi.addRule(projectId, rid, text),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, projectId] }),
  });
}

/** A common issue a person adds to the channel's record (ISS-1184). */
export function useAddCommonIssue(projectId: string, rid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (write: ChannelCommonIssueWrite) => channelsApi.addCommonIssue(projectId, rid, write),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, projectId] }),
  });
}

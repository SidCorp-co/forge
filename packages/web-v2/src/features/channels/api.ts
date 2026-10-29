import type { ChannelMemberView, ChannelMemberWrite, ChannelSummaryView, ChannelView } from "@forge/contracts/support-channel";
import { apiClient } from "@/lib/api/client";

/** A project's bound channels and one channel's record (REQ-75 r6 BC-30). */
export const channelsApi = {
  list: (projectId: string) => apiClient<{ channels: ChannelSummaryView[] }>(`/projects/${projectId}/support/channels`),
  one: (projectId: string, rid: string) =>
    apiClient<{ channel: ChannelView }>(`/projects/${projectId}/support/channels/${encodeURIComponent(rid)}`),
  /** A person's correction: written confirmed (BC-33). */
  confirmMember: (projectId: string, rid: string, username: string, write: ChannelMemberWrite) =>
    apiClient<{ member: ChannelMemberView }>(
      `/projects/${projectId}/support/channels/${encodeURIComponent(rid)}/members/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify(write) },
    ),
};

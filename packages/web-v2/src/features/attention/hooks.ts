"use client";

// web-v2 feature module: attention / inbox — React Query hook.
//
// Query-key contract (ISS-307): the attention list is keyed `['attention']`,
// exactly the key `lib/ws/event-router.ts` invalidates on the events that move
// an item in/out of a bucket (issue.statusChanged, job.statusChanged, device.*,
// notification.created, …) plus `replayOnReconnect`. Cross-project WS only
// arrives on subscribed rooms, so the Attention SCREEN additionally fans out a
// `RoomSub` per project (the Ops-monitor pattern); without that the count is
// stale until the next manual refetch.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDevices } from "@/features/runners/hooks";
import { attentionApi } from "./api";
import type { AttentionItem, AttentionView } from "./types";

/**
 * Cross-project attention/inbox view: the `/me/attention` buckets merged with
 * offline runners derived client-side from `/me/devices`. `total` includes the
 * offline-runner count so the rail badge and the screen agree.
 */
export function useAttention() {
  const attentionQ = useQuery({
    queryKey: ["attention"],
    queryFn: () => attentionApi.list(),
  });
  // `['devices','me']` is already WS-invalidated on device.login/paired/revoked
  // and reconnect — reusing the runners hook keeps the offline bucket live.
  const devicesQ = useDevices();

  const offlineRunners: AttentionItem[] = useMemo(() => {
    const rows = devicesQ.data ?? [];
    return rows
      .filter((d) => d.status === "offline")
      .map((d) => ({
        kind: "runner_offline" as const,
        title: `${d.name} is offline`,
        link: "/runners",
        since: d.lastSeenAt ?? d.createdAt,
        status: "offline",
      }));
  }, [devicesQ.data]);

  const view: AttentionView = useMemo(() => {
    const base = attentionQ.data;
    const needsReview = base?.needsReview ?? [];
    const awaitingInput = base?.awaitingInput ?? [];
    const mentions = base?.mentions ?? [];
    const failedJobs = base?.failedJobs ?? [];
    const pendingSkillUpdates = base?.pendingSkillUpdates ?? [];
    const unseenDrafts = base?.unseenDrafts ?? [];
    return {
      needsReview,
      awaitingInput,
      mentions,
      failedJobs,
      pendingSkillUpdates,
      unseenDrafts,
      // cm:guard pass core's count through, never `unseenDrafts.length` — that list is capped, and recomputing the total from it is how a 22-deep backlog renders as 20 and stops being one anybody chases.
      unseenDraftsTotal: base?.unseenDraftsTotal ?? 0,
      offlineRunners,
      total:
        needsReview.length +
        awaitingInput.length +
        mentions.length +
        failedJobs.length +
        pendingSkillUpdates.length +
        unseenDrafts.length +
        offlineRunners.length,
    };
  }, [attentionQ.data, offlineRunners]);

  return {
    view,
    total: view.total,
    // The badge/screen can render from the attention list alone; devices hydrate
    // the offline bucket a beat later.
    isLoading: attentionQ.isLoading,
    isError: attentionQ.isError,
    error: attentionQ.error,
    refetch: () => {
      attentionQ.refetch();
      devicesQ.refetch();
    },
  };
}

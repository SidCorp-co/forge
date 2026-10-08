"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDevices } from "@/features/runners/hooks";
import { badgeFigure } from "@/design/patterns/badge-read";
import { attentionApi } from "./api";
import type { AttentionItem, AttentionRead, AttentionView } from "./types";

/** What a query has answered: an error is `failed` even where an earlier answer is held, no data yet is `pending`. */
export function queryRead(q: { isError: boolean; data: unknown }): AttentionRead {
  if (q.isError) return "failed";
  return q.data === undefined ? "pending" : "read";
}

/**
 * Cross-project attention/inbox view: the `/me/attention` buckets merged with
 * offline runners derived client-side from `/me/devices`. `total` includes the
 * offline-runner count so the rail badge and the screen agree, and is undefined
 * until both have been read: a count of what one of them has not yet said is not a count.
 * `read` and `devicesRead` say which of the two answered, and a reader states a figure, a
 * badge or an empty list only from `read`. `badge` is what the rails carry: the count where both were
 * read, else the read on its way or failed, never a held count after a failed refetch.
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
      unseenDraftsTotal: base?.unseenDraftsTotal ?? 0,
      // Where nothing has been read, `read` says so; the empty map here is no statement. A response the server sent without totals is refused where it is read.
      projectTotals: base ? base.projectTotals : {},
      offlineRunners,
    };
  }, [attentionQ.data, offlineRunners]);

  const held =
    view.needsReview.length +
    view.awaitingInput.length +
    view.mentions.length +
    view.failedJobs.length +
    view.pendingSkillUpdates.length +
    view.unseenDrafts.length +
    view.offlineRunners.length;

  const read = queryRead(attentionQ);
  const devicesRead = queryRead(devicesQ);
  const badge = useMemo(() => badgeFigure([read, devicesRead], held), [read, devicesRead, held]);

  return {
    view,
    total: read === "read" && devicesRead === "read" ? held : undefined,
    read,
    devicesRead,
    badge,
    error: attentionQ.error,
    devicesError: devicesQ.error,
    refetch: () => {
      attentionQ.refetch();
      devicesQ.refetch();
    },
  };
}

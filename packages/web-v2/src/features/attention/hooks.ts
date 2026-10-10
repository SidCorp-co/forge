"use client";

import { useQuery } from "@tanstack/react-query";
import { useDevices } from "@/features/runners";
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

  const offlineRunners: AttentionItem[] = (devicesQ.data ?? [])
    .filter((d) => d.status === "offline")
    .map((d) => ({ kind: "runner_offline" as const, title: `${d.name} is offline`, link: "/runners", since: d.lastSeenAt ?? d.createdAt, status: "offline" }));
  const base = attentionQ.data;
  const buckets = {
    needsYou: base?.needsYou ?? [],
    mentions: base?.mentions ?? [],
    failedJobs: base?.failedJobs ?? [],
    channelGates: base?.channelGates ?? [],
    statusReports: base?.statusReports ?? [],
    offlineRunners,
  };
  const view: AttentionView = { ...buckets, total: Object.values(buckets).reduce((n, b) => n + b.length, 0) };

  return {
    view,
    total: view.total,
    // The badge/screen can render from the attention list alone; devices hydrate
    // the offline bucket a beat later.
    isLoading: attentionQ.isLoading,
    isError: attentionQ.isError,
    error: attentionQ.error,
    refetch: () => {
      void attentionQ.refetch();
      void devicesQ.refetch();
    },
  };
}

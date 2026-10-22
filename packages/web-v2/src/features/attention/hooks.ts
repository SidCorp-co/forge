
import { useQuery } from "@tanstack/react-query";
import { useDevices } from "@/features/runners";
import { useCopy } from "@/lib/i18n/interface-language";
import { attentionApi } from "./api";
import type { AttentionItem, AttentionView } from "./types";

/**
 * Cross-project attention/inbox view: the `/me/attention` buckets merged with
 * offline runners derived client-side from `/me/devices`. `total` includes the
 * offline-runner count so the rail badge and the screen agree, and each project's
 * Needs you part counts its whole `total`.
 */
export function useAttention() {
  const attentionQ = useQuery({
    queryKey: ["attention"],
    queryFn: () => attentionApi.list(),
  });
  // `['devices','me']` is already WS-invalidated on device.login/paired/revoked
  // and reconnect — reusing the runners hook keeps the offline bucket live.
  const devicesQ = useDevices();
  const t = useCopy();

  const offlineRunners: AttentionItem[] = (devicesQ.data ?? [])
    .filter((d) => d.status === "offline")
    .map((d) => ({ kind: "runner_offline" as const, title: t("attention.runnerOffline", { name: d.name }), link: "/runners", since: d.lastSeenAt ?? d.createdAt, status: "offline" }));
  const base = attentionQ.data;
  const buckets = {
    needsYou: base?.needsYou ?? [],
    mentions: base?.mentions ?? [],
    failedJobs: base?.failedJobs ?? [],
    channelGates: base?.channelGates ?? [],
    statusReports: base?.statusReports ?? [],
    offlineRunners,
  };
  // a project's Needs you part counts its whole `total`, the number its Approvals page and menu badge read
  // (REQ-48 BC-11); every other bucket counts its rows
  const { needsYou, ...rest } = buckets;
  const total = needsYou.reduce((n, p) => n + p.total, 0) + Object.values(rest).reduce((n, b) => n + b.length, 0);
  const waitingOnYou = base?.waitingOnYou ?? 0;
  const view: AttentionView = { ...buckets, waitingOnYou, total };

  return {
    view,
    total: view.total,
    /** Core's decisions-across-projects figure: what the Attention tab and the Overview badge carry (REQ-48 r3 BC-17). */
    waitingOnYou,
    /** Whether core has answered, so a badge never reads 0 for "not read yet". */
    known: base !== undefined,
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

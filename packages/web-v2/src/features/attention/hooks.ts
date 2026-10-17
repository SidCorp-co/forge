"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useDevices } from "@/features/runners/hooks";
import { badgeFigure, queryRead } from "@/design/patterns/badge-read";
import { attentionApi } from "./api";
import { ATTENTION_BUCKETS, type AttentionBucket, type AttentionItem, type AttentionView } from "./types";

const NO_BUCKET_TOTALS = Object.fromEntries(ATTENTION_BUCKETS.map((b) => [b, 0])) as Record<
  AttentionBucket,
  number
>;

/**
 * Cross-project attention/inbox view: the `/me/attention` buckets merged with
 * offline runners derived client-side from `/me/devices`. `total` is every item the buckets hold,
 * listed or not, plus the offline runners, so the rail badge and the screen say one number for one
 * set (ISS-1229 r14), and is undefined until both have been read: a count of what one of them has
 * not yet said is not a count. `expand` names the buckets to list whole rather than capped, and
 * `orgId` reads one organisation in place of the active one: a project's page reads its own.
 * `read`/`devicesRead` say which answered; state a figure, badge or empty list only from `read`.
 * The buckets are the active organisation's, cut before the caps and read once it is known.
 * `badge` is the count where both were read, never a held count after a failed refetch.
 */
export function useAttention(
  opts: { expand?: readonly AttentionBucket[]; orgId?: string | null } = {},
) {
  const active = useActiveOrg();
  const own = opts.orgId !== undefined;
  const orgId = own ? opts.orgId : active.activeOrgId;
  const scopeError = own ? null : active.scopeError;
  const expanded = [...(opts.expand ?? [])].sort();
  const attentionQ = useQuery({
    queryKey: ["attention", orgId, expanded],
    queryFn: () => attentionApi.list(orgId, expanded),
    enabled: own ? orgId !== null : active.scopeRead,
    // Asking for a group whole keeps the page on screen while it is read; another organisation never
    // shows this one's rows meanwhile.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === orgId ? previous : undefined,
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
      bucketTotals: base?.bucketTotals ?? NO_BUCKET_TOTALS,
      total: base?.total ?? 0,
      // Where nothing has been read, `read` says so; the empty map here is no statement. A response the server sent without totals is refused where it is read.
      projectTotals: base ? base.projectTotals : {},
      offlineRunners,
    };
  }, [attentionQ.data, offlineRunners]);

  const held = view.total + view.offlineRunners.length;

  const read = scopeError ? "failed" : queryRead(attentionQ);
  const devicesRead = queryRead(devicesQ);
  const badge = useMemo(() => badgeFigure([read, devicesRead], held), [read, devicesRead, held]);

  return {
    view,
    total: read === "read" && devicesRead === "read" ? held : undefined,
    read,
    devicesRead,
    badge,
    error: scopeError ?? attentionQ.error,
    devicesError: devicesQ.error,
    refetch: () => {
      if (scopeError) active.retryScope();
      else attentionQ.refetch();
      devicesQ.refetch();
    },
  };
}

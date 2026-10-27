"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useDevices } from "@/features/runners/hooks";
import { badgeFigure, queryRead } from "@/design/patterns/badge-read";
import { attentionApi } from "./api";
import { ATTENTION_BUCKETS, type AttentionBucket, type AttentionItem, type AttentionView } from "./types";
import { failureToast } from "@/lib/api/failure-toast";

const NO_BUCKET_TOTALS = Object.fromEntries(ATTENTION_BUCKETS.map((b) => [b, 0])) as Record<
  AttentionBucket,
  number
>;

/**
 * The `/me/attention` buckets merged with offline runners from `/me/devices`. `total` is every item
 * the buckets hold, listed or not, plus the offline runners, undefined until both were read
 * (ISS-1229 r14). `expand` lists buckets whole; `orgId` reads one organization in place of the
 * active one. State a figure or empty list only from `read`; `badge` is never a held count after a
 * failed refetch.
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
    // Asking for a group whole keeps the page on screen while it is read; another organization never
    // shows this one's rows meanwhile.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === orgId ? previous : undefined,
  });
  // `['devices','me']` is already WS-invalidated on device.login/paired/revoked
  // and reconnect — reusing the runners hook keeps the offline bucket live. The organization read is
  // the devices' too: a box bound only to another organization's projects is not this one's (ISS-1229 r16).
  const devicesQ = useDevices(orgId);

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
    /** A group asked for whole is still on its way: the rows on screen are the capped ones. */
    expanding: attentionQ.isPlaceholderData,
    badge,
    error: scopeError ?? attentionQ.error,
    devicesError: devicesQ.error,
    refetch: () => {
      if (scopeError) active.retryScope();
      else attentionQ.refetch();
      devicesQ.refetch();
    },
    retryAttention: () => (scopeError ? active.retryScope() : void attentionQ.refetch()),
    retryDevices: () => void devicesQ.refetch(),
  };
}

/**
 * Retry a failed job from a Needs you row (ISS-1229 r16): the button retries the job, through the one
 * route a person retries a failed job by, and the row leaves the list once its read is refreshed.
 */
export function useRetryFailedJob() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (jobId: string) => attentionApi.retryJob(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attention"] });
      qc.invalidateQueries({ queryKey: ["jobs", "list"] });
      qc.invalidateQueries({ queryKey: ["projects", "health"] });
      toast({ title: "Job queued again", tone: "success" });
    },
    onError: (err) => {
      toast(failureToast(err, "The job was not retried"));
    },
  });
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SeenRelease, whatsNewApi } from "./api";
import type { WhatsNewFeed, WhatsNewSummary } from "./types";

const FEED_KEY = ["me", "whats-new"] as const;
const SUMMARY_KEY = ["me", "whats-new", "summary"] as const;

/** Whether the serving release is owed: a few hundred bytes on every page, never the release. */
export function useWhatsNewSummary() {
  return useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: whatsNewApi.summary,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The release itself, read afresh each time the panel opens and never before. */
export function useWhatsNew(open: boolean) {
  return useQuery({
    queryKey: FEED_KEY,
    queryFn: whatsNewApi.feed,
    enabled: open,
    staleTime: 0,
    retry: false,
  });
}

/** Closing What's new on a release writes the mark; the dot clears as the write lands. */
export function useMarkWhatsNewSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (release: SeenRelease) => whatsNewApi.markSeen(release, new Date()),
    onSuccess: (_state, release) => {
      qc.setQueryData<WhatsNewSummary>(SUMMARY_KEY, (summary) =>
        summary?.release?.version === release.version
          ? { ...summary, release: { ...summary.release, owed: false } }
          : summary,
      );
      qc.setQueryData<WhatsNewFeed>(FEED_KEY, (feed) =>
        feed?.release?.version === release.version ? { ...feed, release: { ...feed.release, owed: false } } : feed,
      );
    },
  });
}

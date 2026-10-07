"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { whatsNewApi } from "./api";
import type { WhatsNewFeed, WhatsNewSummary } from "./types";

const WHATS_NEW_KEY = ["me", "whats-new"] as const;
const SUMMARY_KEY = ["me", "whats-new", "summary"] as const;

/** The reader's own time zone, which the feed groups days in. */
function readerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Whether anything is unread: a few hundred bytes on every page, never the entries. */
export function useWhatsNewSummary() {
  return useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: whatsNewApi.summary,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The feed itself, read afresh each time the panel opens and never before. */
export function useWhatsNew(open: boolean) {
  return useQuery({
    queryKey: WHATS_NEW_KEY,
    queryFn: () => whatsNewApi.feed(readerTimeZone()),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
}

/** Opening What's new moves the seen mark to now; the dot clears as the write lands. */
export function useMarkWhatsNewSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => whatsNewApi.markSeen(new Date()),
    onSuccess: () => {
      qc.setQueryData<WhatsNewSummary>(SUMMARY_KEY, (summary) =>
        summary ? { ...summary, unread: 0, counts: { new: 0, improved: 0, fixed: 0 } } : summary,
      );
      qc.setQueryData<WhatsNewFeed>(WHATS_NEW_KEY, (feed) =>
        feed
          ? {
              ...feed,
              unread: 0,
              days: feed.days.map((d) => ({ ...d, entries: d.entries.map((e) => ({ ...e, unread: false })) })),
            }
          : feed,
      );
    },
  });
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { whatsNewApi } from "./api";
import type { WhatsNewFeed } from "./types";

const WHATS_NEW_KEY = ["me", "whats-new"] as const;

/** The reader's own time zone, which the feed groups days in. */
function readerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useWhatsNew() {
  return useQuery({
    queryKey: WHATS_NEW_KEY,
    queryFn: () => whatsNewApi.feed(readerTimeZone()),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Opening What's new moves the seen mark to now; the dot clears as the write lands. */
export function useMarkWhatsNewSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => whatsNewApi.markSeen(new Date()),
    onSuccess: () => {
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

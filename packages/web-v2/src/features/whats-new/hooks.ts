"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { type SeenRelease, whatsNewApi } from "./api";
import type { WhatsNewFeed, WhatsNewSummary } from "./types";

const FEED_KEY = ["me", "whats-new"] as const;
const SUMMARY_KEY = ["me", "whats-new", "summary"] as const;

/** The releases this tab has already opened What's new on by itself: once each, however many entries mount. */
const openedByItself = new Set<string>();
/** The owed release the summary read last opened What's new on by itself, and who listens for it. */
let autoOpened: string | null = null;
const autoListeners = new Set<() => void>();

/** Test seam: forget what this tab opened. */
export function forgetOpenedWhatsNew() {
  openedByItself.clear();
  autoOpened = null;
}

/** The summary's arrival is the event that opens What's new on an owed release, once per tab. */
async function readSummary(): Promise<WhatsNewSummary> {
  const summary = await whatsNewApi.summary();
  const release = summary.release;
  const key = release?.owed ? `${summary.environment}:${release.version}` : null;
  if (key && !openedByItself.has(key)) {
    openedByItself.add(key);
    autoOpened = key;
    for (const listener of autoListeners) listener();
  }
  return summary;
}

/** The owed release What's new opened on by itself, or null. */
export function useAutoOpenedRelease(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      autoListeners.add(onChange);
      return () => autoListeners.delete(onChange);
    },
    () => autoOpened,
    () => null,
  );
}

/** Whether the serving release is owed: a few hundred bytes on every page, never the release. */
export const useWhatsNewSummary = () => useQuery({ queryKey: SUMMARY_KEY, queryFn: readSummary, staleTime: 5 * 60_000, retry: false });

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

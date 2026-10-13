
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { type SeenRelease, whatsNewApi } from "./api";
import type { WhatsNewFeed, WhatsNewSummary } from "./types";

const FEED_KEY = ["me", "whats-new"] as const;
const SUMMARY_KEY = ["me", "whats-new", "summary"] as const;

/** The releases this tab has already opened What's new on by itself: once each, however many entries mount. */
const openedByItself = new Set<string>();
/**
 * The owed release What's new is open on by itself, and the one mounted entry that shows it: the
 * first listening when the summary arrived. Closing it, or that entry unmounting, ends it, so a page
 * read again does not open it twice and two mounted entries never open two panels.
 */
let autoOpened: { key: string; owner: symbol } | null = null;
const autoListeners = new Map<symbol, () => void>();

const notifyAuto = () => {
  for (const listener of autoListeners.values()) listener();
};

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
  const [owner] = autoListeners.keys();
  if (key && owner && !openedByItself.has(key)) {
    openedByItself.add(key);
    autoOpened = { key, owner };
    notifyAuto();
  }
  return summary;
}

/** Ends the open What's new took by itself, whichever entry showed it. */
export function closeAutoOpened() {
  if (autoOpened === null) return;
  autoOpened = null;
  notifyAuto();
}

/** The owed release What's new opened on by itself, where this entry is the one that shows it; else null. */
export function useAutoOpenedRelease(): string | null {
  // one subscription for the entry's life: a fresh one each render would read as an unmount and end it
  const [entry] = useState(() => {
    const me = Symbol("whats-new-entry");
    return {
      subscribe: (onChange: () => void) => {
        autoListeners.set(me, onChange);
        return () => {
          autoListeners.delete(me);
          if (autoOpened?.owner === me) closeAutoOpened();
        };
      },
      read: () => (autoOpened?.owner === me ? autoOpened.key : null),
    };
  });
  return useSyncExternalStore(entry.subscribe, entry.read, () => null);
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

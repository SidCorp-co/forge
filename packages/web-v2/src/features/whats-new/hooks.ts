"use client";

// web-v2 feature: What's New — the in-app Forge release feed (ISS-384).
// Product-global source (Forge's CHANGELOG via GitHub), NOT the per-project
// docs API. The per-user "seen" marker rides the existing preferences row.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ChangelogRelease,
  changelogTopId,
  fetchForgeChangelog,
  parseChangelog,
} from "@/lib/changelog";
import { settingsApi } from "@/features/settings/api";
import { usePreferences } from "@/features/settings/hooks";

/** The parsed Forge changelog feed. Keyed `['whats-new']`, cached 1h. Rejects
 *  when the changelog is unreachable so the screen shows an error+retry. */
export function useWhatsNew() {
  return useQuery({
    queryKey: ["whats-new"],
    queryFn: async (): Promise<ChangelogRelease[]> => {
      const md = await fetchForgeChangelog();
      if (md === null) throw new Error("Couldn't reach the Forge changelog.");
      return parseChangelog(md);
    },
    staleTime: 60 * 60 * 1000,
  });
}

/** Feed + the user's last-seen marker. `hasUnseen` drives the nav badge;
 *  `markSeen` silently records the current top entry (no toast) when the user
 *  opens the feed. */
export function useWhatsNewStatus() {
  const qc = useQueryClient();
  const feed = useWhatsNew();
  const prefs = usePreferences();

  const topId = feed.data ? changelogTopId(feed.data) : null;
  const lastSeen = prefs.data?.lastSeenWhatsNew ?? null;
  const hasUnseen = !!topId && topId !== lastSeen;

  async function markSeen() {
    if (!topId || topId === lastSeen) return;
    const next = await settingsApi.updatePreferences({ lastSeenWhatsNew: topId });
    qc.setQueryData(["settings", "preferences"], next);
  }

  return { ...feed, topId, lastSeen, hasUnseen, markSeen };
}

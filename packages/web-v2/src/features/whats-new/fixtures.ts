import { releasePage } from "@/test/release-page";
import type { WhatsNewFeed, WhatsNewRelease, WhatsNewSummary } from "./types";

/** The release a dev instance serves, owed to the reader: the highlights of a release page and two lines. */
export function releaseOf(over: Partial<WhatsNewRelease> = {}): WhatsNewRelease {
  return {
    version: "0.4.0-dev.9",
    releasedAt: "2026-10-09T10:00:00.000Z",
    owed: true,
    highlights: releasePage().highlights,
    changes: [
      { kind: "new", line: "Releases read as pages." },
      { kind: "fixed", line: "Dates show correctly." },
    ],
    ...over,
  };
}

export function feedOf(release: WhatsNewRelease | null = releaseOf(), environment = "dev"): WhatsNewFeed {
  return { environment, release };
}

export function summaryOf(feed: WhatsNewFeed): WhatsNewSummary {
  return {
    environment: feed.environment,
    release: feed.release ? { version: feed.release.version, owed: feed.release.owed } : null,
  };
}

import { releaseChangeGroupOf } from "@forge/contracts/release-digest";
import type { ReleasePage } from "@forge/contracts/release-page";

// A release read as the approved report (ISS-1001): its changes in the words of their release notes,
// and what the decider must weigh. No issue key, commit, branch or change request is part of either:
// those are the Technical section's.

/** How many changes nobody using the product sees, or that carry no note for users yet. */
export const unseenCount = (page: Pick<ReleasePage, "internal" | "withoutNotes">): number => page.internal.count + page.withoutNotes.length;

/** The changes that take something away from users, by their short title. */
export const removedLines = (page: Pick<ReleasePage, "improvements" | "fixes">): string[] =>
  [...page.improvements, ...page.fixes].filter((c) => releaseChangeGroupOf(c) === "removed").map((c) => c.line);

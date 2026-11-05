import { releaseChangeGroupOf } from "@forge/contracts/release-digest";
import type { ReleasePage } from "@forge/contracts/release-page";

// A release read as the approved report (ISS-1001): what users see, by the screen they meet each
// change on, in the words of its release note; and what the decider must weigh. No issue key, commit,
// branch or change request is part of either: those are the Technical section's.

export interface ScreenLine {
  /** The note's short title, whole. */
  text: string;
  /** The one sentence that says it in full, where the note has one. */
  detail: string | null;
  removed: boolean;
}

export interface ScreenChanges {
  /** The screen, from the change's issue module (core `release-page/read.ts:screensOf`); null where none is named. */
  screen: string | null;
  lines: ScreenLine[];
}

/** The release's changes grouped by screen, screens in the order their first change comes, unnamed last. */
export function changesByScreen(page: Pick<ReleasePage, "improvements" | "fixes">): ScreenChanges[] {
  const by = new Map<string | null, ScreenLine[]>();
  for (const c of [...page.improvements, ...page.fixes]) {
    const screen = c.screen ?? null;
    by.set(screen, [...(by.get(screen) ?? []), { text: c.line, detail: c.detail, removed: releaseChangeGroupOf(c) === "removed" }]);
  }
  const named = [...by].filter(([s]) => s !== null);
  const unnamed = by.get(null);
  return [...named.map(([screen, lines]) => ({ screen, lines })), ...(unnamed ? [{ screen: null, lines: unnamed }] : [])];
}

/** How many changes nobody using the product sees, or that carry no note for users yet. */
export const unseenCount = (page: Pick<ReleasePage, "internal" | "withoutNotes">): number => page.internal.count + page.withoutNotes.length;

/** The changes that take something away from users, by their short title. */
export const removedLines = (page: Pick<ReleasePage, "improvements" | "fixes">): string[] =>
  changesByScreen(page).flatMap((s) => s.lines.filter((l) => l.removed).map((l) => l.text));

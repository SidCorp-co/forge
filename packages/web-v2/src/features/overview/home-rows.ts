// The home's rows as pure reads of what core served (ISS-919): Moving splits on core's own `idle`, and
// each item opens on its own place. The screen renders these and counts nothing of its own.

import { feedbackHref } from "@/lib/routes/feedback";
import { issuesHref } from "@/lib/routes/issues";
import type { LegendTone } from "@/design";
import type { HomeMovingItem, HomeStage } from "./types";

/** Moving split on core's `idle`: what moves, in core's order, and what folds under Idle. */
export function movingSplit(items: readonly HomeMovingItem[]): { active: HomeMovingItem[]; idle: HomeMovingItem[] } {
  return { active: items.filter((m) => !m.idle), idle: items.filter((m) => m.idle) };
}

/** The page an item opens on: an issue in the list's peek, a feedback item on its page. */
export function itemHref(item: Pick<HomeMovingItem, "kind" | "key" | "projectSlug">): string {
  return item.kind === "issue"
    ? `${issuesHref(item.projectSlug)}?peek=${encodeURIComponent(item.key)}`
    : feedbackHref(item.projectSlug, item.key);
}

/** A stage's tone in the status legend. */
export const STAGE_TONE: Record<HomeStage, LegendTone> = {
  new: "neutral",
  planned: "ready",
  building: "run",
  landed: "done",
  releasing: "run",
};

/** Rows a section shows before its "show more": the first screen stays within the page's word budget. */
export const HOME_ROWS = 3;

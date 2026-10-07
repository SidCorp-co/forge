import type { TourEventKind } from "@forge/contracts/tours";
import { driver } from "driver.js";
import type { Copy } from "@/lib/i18n/product-copy";
import type { TourDefinition, TourStep } from "./registry";

export interface TourHooks {
  onEvent: (kind: TourEventKind, step?: number) => void;
  onOutcome: (outcome: "completed" | "dismissed", step?: number) => void;
}

const selectorOf = (step: TourStep) => `[data-tour="${step.anchor}"]`;

/** The steps whose anchor is on the page and drawn, each with its number in the tour; the rest missing. */
export function presentSteps(tour: TourDefinition, root: ParentNode = document) {
  const present: Array<TourStep & { n: number }> = [];
  const missing: number[] = [];
  tour.steps.forEach((step, i) => {
    const el = root.querySelector(selectorOf(step));
    if (el && el.getClientRects().length > 0) present.push({ ...step, n: i + 1 });
    else missing.push(i + 1);
  });
  return { present, missing };
}

/**
 * Drive a tour over the steps whose anchors are on the page. A missing anchor skips its step and
 * records `step_skipped`, so no popover points at nothing; with none present the tour does not
 * start. Answers whether it started.
 */
export function runTour(tour: TourDefinition, t: Copy, hooks: TourHooks): boolean {
  const { present, missing } = presentSteps(tour);
  for (const n of missing) hooks.onEvent("step_skipped", n);
  if (present.length === 0) return false;
  hooks.onEvent("started");
  let settled = false;
  const settle = (outcome: "completed" | "dismissed", step?: number) => {
    if (settled) return;
    settled = true;
    hooks.onEvent(outcome, step);
    hooks.onOutcome(outcome, step);
  };
  const tourDriver = driver({
    popoverClass: "forge-tour",
    showProgress: true,
    progressText: t("tours.progress"),
    nextBtnText: t("tours.next"),
    prevBtnText: t("tours.prev"),
    doneBtnText: t("tours.done"),
    allowClose: true,
    overlayOpacity: 0.35,
    stageRadius: 6,
    steps: present.map((s) => ({
      element: selectorOf(s),
      popover: { title: t(s.title), description: t(s.body) },
    })),
    // driver.js scrolls a step into view centred inline too, which drags any wide, clipped ancestor
    // (the release train) sideways; bringing it into view vertically first leaves it nothing to do
    onHighlightStarted: (el) => {
      el?.scrollIntoView?.({ block: "center", inline: "nearest" });
    },
    onDoneClick: (_el, _step, { driver: active }) => {
      settle("completed");
      active.destroy();
    },
    // a close, an Escape or a click on the overlay: the person left at the step in front of them
    onDestroyStarted: (_el, _step, { driver: active }) => {
      settle("dismissed", present[active.getActiveIndex() ?? 0]?.n ?? 1);
      active.destroy();
    },
  });
  tourDriver.drive();
  return true;
}

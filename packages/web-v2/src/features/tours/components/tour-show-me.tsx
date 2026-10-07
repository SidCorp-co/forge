"use client";

import Link from "next/link";
import type { WhatsNewEntryAction } from "@/features/whats-new/components/whats-new-panel";
import { useTourCopy, useTourTarget } from "../hooks";
import { tourById } from "../registry";

/** An entry's "Show me": a link to the page of the open project its tour runs on, `?tour=` set, so the page opens it. */
function TourShowMe({ tourId }: { tourId: string }) {
  const t = useTourCopy();
  const target = useTourTarget();
  const tour = tourById(tourId);
  const href = tour ? target(tour) : null;
  if (!tour || !href) return null;
  return (
    <Link href={href} className="text-13 font-semibold text-accent-text hover:underline" data-testid="whats-new-tour-link">
      {t("tours.showMe", { count: tour.steps.length })}
    </Link>
  );
}

/** What's new hands each entry here; one a changelog `tour:` line names offers that tour. */
export const tourShowMe: WhatsNewEntryAction = (entry) => (entry.tour ? <TourShowMe tourId={entry.tour.id} /> : null);

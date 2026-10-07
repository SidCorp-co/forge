"use client";

import Link from "next/link";
import type { WhatsNewEntryAction } from "@/features/whats-new/components/whats-new-panel";
import { useTourCopy } from "../hooks";
import { tourHref } from "../links";
import { tourById } from "../registry";

/** An entry's "Show me": a link to the page its tour runs on, `?tour=` set, so the page opens it. */
function TourShowMe({ tourId, slug, version }: { tourId: string; slug: string | null; version: string }) {
  const t = useTourCopy();
  const tour = tourById(tourId);
  const href = tour ? tourHref(tour, slug, { version }) : null;
  if (!tour || !href) return null;
  return (
    <Link href={href} className="text-13 font-semibold text-accent-text hover:underline" data-testid="whats-new-tour-link">
      {t("tours.showMe", { count: tour.steps.length })}
    </Link>
  );
}

/** What's new hands each entry here; one an issue's tour belongs to offers that tour. */
export const tourShowMe: WhatsNewEntryAction = (entry, slug) =>
  entry.tour ? <TourShowMe tourId={entry.tour.id} slug={slug} version={entry.version} /> : null;

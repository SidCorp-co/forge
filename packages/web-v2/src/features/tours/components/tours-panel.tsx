"use client";

import { usePathname, useRouter } from "next/navigation";
import { Button, SlideOver } from "@/design";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useStartTour, useTourCopy, useTourStates, useTourTarget } from "../hooks";
import { onTourRoute, TOURS, type TourDefinition } from "../registry";
import { standingOf } from "../state";

/** Help → Tours: every tour, how the person stands with it at its revision, and a way to take it again. */
export function ToursPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTourCopy();
  const { states } = useTourStates();
  const start = useStartTour();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const search = useLocationSearch();
  const target = useTourTarget();

  function show(tour: TourDefinition) {
    onClose();
    if (onTourRoute(tour, pathname, new URLSearchParams(search))) {
      start(tour);
      return;
    }
    const href = target(tour);
    if (href) router.push(href);
  }

  return (
    <SlideOver open={open} onClose={onClose} title={t("help.title")} width={440}>
      <ul className="-mt-2" data-testid="tours-list">
        {TOURS.map((tour) => {
          const standing = standingOf(tour, states.get(tour.id));
          const label = t(standing === "seen" ? "tours.seen" : standing === "updated" ? "tours.updated" : "tours.notSeen");
          const reachable = onTourRoute(tour, pathname, new URLSearchParams(search)) || target(tour) !== null;
          return (
            <li key={tour.id} className="flex items-center gap-2.5 border-b border-line py-2.5" data-testid={`tour-row-${tour.id}`}>
              <span className="min-w-0 flex-1">
                <span className="block text-13-5 text-fg">{t(tour.title)}</span>
                <span className="block text-12 text-subtle" data-standing={standing}>
                  {t("tours.meta", { count: tour.steps.length, revision: tour.revision, state: label })}
                  {standing === "updated" && (
                    <span aria-hidden data-testid="tour-updated-dot" className="ml-1.5 inline-block size-[7px] rounded-pill bg-accent align-middle" />
                  )}
                </span>
                {!reachable && <span className="block text-12 text-subtle">{t("tours.noPage")}</span>}
              </span>
              <Button variant="secondary" size="sm" disabled={!reachable} onClick={() => show(tour)}>
                {t("tours.show")}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 max-w-[72ch] border-t border-line pt-3 text-12-5 text-subtle">
        {t("tours.note")} <code className="font-mono">?tour=release-what-changes</code>
      </p>
    </SlideOver>
  );
}

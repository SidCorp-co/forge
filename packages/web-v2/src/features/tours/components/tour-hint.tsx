"use client";

import { useState } from "react";
import { Button } from "@/design";
import { useCurrentProject } from "@/features/projects/current-project";
import { formatRefusal } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useSaveTourState, useStartTour, useTourCopy, useTourStates } from "../hooks";
import { inAudience, tourById } from "../registry";
import { offersHint } from "../state";

/**
 * The inline first-visit offer on a page a tour runs on: one line, the person chooses. Never a
 * modal and never on a timer; gone once the tour was finished or set aside at this revision.
 */
export function TourHint({ tourId, projectRole }: { tourId: string; projectRole?: string | null }) {
  const tour = tourById(tourId);
  const project = useCurrentProject();
  const { states, isSuccess } = useTourStates();
  const start = useStartTour();
  const save = useSaveTourState();
  const t = useTourCopy();
  const { toast } = useToast();
  // Later goes at once, before core answers: a person who set it aside never waits on a read to see it go
  const [setAside, setSetAside] = useState(false);
  if (!tour || !isSuccess || setAside) return null;
  const state = states.get(tour.id);
  if (!offersHint(tour, state) || !inAudience(tour, projectRole ?? project?.role)) return null;
  const count = tour.steps.length;
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2.5 border-y border-line py-2.5 text-13-5 text-fg"
      data-testid={`tour-hint-${tour.id}`}
      role="note"
    >
      <span className="min-w-[200px] flex-1">{t(state ? tour.hint.updated : tour.hint.new, { count })}</span>
      <Button variant="primary" size="sm" onClick={() => start(tour)}>
        {t("tours.hint.show", { count })}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setSetAside(true);
          save.mutate(
            { id: tour.id, value: { revision: tour.revision, outcome: "dismissed", at: new Date().toISOString() } },
            // a refusal is said, never swallowed: unsaid, the hint comes back on the next visit and nothing explains why
            { onError: (err) => toast({ title: "Could not remember that", description: `${formatRefusal(err)} It will be offered again on your next visit.`, tone: "error" }) },
          );
        }}
      >
        {t("tours.hint.later")}
      </Button>
    </div>
  );
}

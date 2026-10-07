"use client";

import type { TourStateValue } from "@forge/contracts/product-state";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useCurrentProject } from "@/features/projects/current-project";
import { productCopy } from "@/lib/i18n/product-copy";
import { toursApi } from "./api";
import { tourHref } from "./links";
import { useTourRelease } from "./release-context";
import type { TourDefinition } from "./registry";
import { runTour } from "./run-tour";
import { tourStatesOf } from "./state";

export const TOUR_STATES_KEY = ["me", "product-state"] as const;

export function useTourStates() {
  const query = useQuery({ queryKey: TOUR_STATES_KEY, queryFn: toursApi.states, staleTime: 5 * 60_000 });
  return { ...query, states: tourStatesOf(query.data?.items ?? []) };
}

export function useSaveTourState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: TourStateValue }) => toursApi.save(id, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: TOUR_STATES_KEY }),
  });
}

/** The chrome tours speak. */
export function useTourCopy() {
  return productCopy();
}

/** Where a tour opens: a page of the open project, a release of it for the release tour; null where none is open. */
export function useTourTarget() {
  const project = useCurrentProject();
  const latest = useTourRelease() ?? undefined;
  return (tour: TourDefinition) =>
    tour.id === "release-what-changes"
      ? tourHref(tour, project?.slug, { version: latest })
      : tourHref(tour, project?.slug);
}

/** Start a tour on the page in front of the person, recording what happens and storing how it ended. */
export function useStartTour() {
  const t = useTourCopy();
  const save = useSaveTourState();
  return useCallback(
    (tour: TourDefinition) =>
      runTour(tour, t, {
        onEvent: (kind, step) => {
          toursApi.record({ tourId: tour.id, revision: tour.revision, kind, ...(step ? { step } : {}) }).catch(() => {});
        },
        onOutcome: (outcome, step) => {
          save.mutate({
            id: tour.id,
            value: { revision: tour.revision, outcome, ...(step ? { step } : {}), at: new Date().toISOString() },
          });
        },
      }),
    [t, save],
  );
}

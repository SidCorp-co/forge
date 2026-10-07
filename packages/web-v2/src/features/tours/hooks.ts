"use client";

import type { TourStateValue } from "@forge/contracts/product-state";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { productCopy } from "@/lib/i18n/product-copy";
import { useWhatsNew } from "@/features/whats-new/hooks";
import { toursApi } from "./api";
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

/** The chrome language tours speak: the platform project's content language, English beneath. */
export function useTourCopy() {
  return productCopy(useWhatsNew().data?.contentLanguage);
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

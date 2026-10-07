import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNow, useUrlChoice } from "@/design";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { forecastApi } from "./api";
import type { EtaClock } from "./eta";

// keyed under ['issues','standing'] so the event router, which invalidates that prefix on every issue
// event, recomputes the forecast on each transition with no timer of its own
const KEY = ["issues", "standing", "forecast"] as const;

export function useProjectForecast(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "project", projectId ?? ""],
    queryFn: () => forecastApi.project(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useIssueForecast(projectId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "issue", projectId ?? "", key ?? ""],
    queryFn: () => forecastApi.issue(projectId as string, key as string),
    enabled: Boolean(projectId && key),
    staleTime: 10_000,
  });
}

export function useRequirementForecast(projectId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "requirement", projectId ?? "", key ?? ""],
    queryFn: () => forecastApi.requirement(projectId as string, key as string),
    enabled: Boolean(projectId && key),
    staleTime: 10_000,
  });
}

export function useDraftReleaseForecast(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "release-draft", projectId ?? ""],
    queryFn: () => forecastApi.draftRelease(projectId as string),
    enabled: Boolean(projectId) && enabled,
    staleTime: 10_000,
  });
}

export function useRequirementForecasts(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "requirements", projectId ?? ""],
    queryFn: () => forecastApi.requirements(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

/** A triage moves an item's line though no issue moved, so the feedback acts invalidate it by this key. */
export const feedbackForecastKey = (projectId: string) => [...KEY, "feedback", projectId] as const;

export function useFeedbackForecasts(projectId: string | undefined) {
  return useQuery({
    queryKey: feedbackForecastKey(projectId ?? ""),
    queryFn: () => forecastApi.feedback(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useComingNext(projectId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "coming-next", projectId ?? ""],
    queryFn: () => forecastApi.comingNext(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

/** The ETA column's language and clock: the interface language, the viewer's timezone, now. */
export function useEtaClock(): EtaClock {
  const lang = useInterfaceLanguage();
  const now = useNow(60_000);
  return useMemo(() => ({ lang, now }), [lang, now]);
}

const ETA_SORTS = ["default", "eta"] as const;

/** Whether a list is sorted by its ETA column, kept in the URL as `sort=eta`, and the header's toggle. */
export function useEtaSort(): [boolean, () => void] {
  const [sort, setSort] = useUrlChoice("sort", ETA_SORTS, "default");
  return [sort === "eta", () => setSort(sort === "eta" ? "default" : "eta")];
}

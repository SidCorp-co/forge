import { useQuery } from "@tanstack/react-query";
import { useUrlChoice } from "@/design";
import { readOf } from "@/lib/api/query-kit";
import { forecastApi } from "./api";

// keyed under ['issues','standing'] so the event router, which invalidates that prefix on every issue
// event, recomputes the forecast on each transition with no timer of its own
const KEY = ["issues", "standing", "forecast"] as const;

/** One forecast read under the standing prefix, fresh for ten seconds. */
const forecastRead = <T,>(kind: string, parts: readonly (string | undefined)[], read: () => Promise<T>) => readOf([...KEY, kind, ...parts], read, 10_000);

export const useProjectForecast = (projectId: string | undefined) => useQuery(forecastRead("project", [projectId], () => forecastApi.project(projectId as string)));

export const useIssueForecast = (projectId: string | undefined, key: string | undefined) =>
  useQuery(forecastRead("issue", [projectId, key], () => forecastApi.issue(projectId as string, key as string)));

export const useRequirementForecast = (projectId: string | undefined, key: string | undefined) =>
  useQuery(forecastRead("requirement", [projectId, key], () => forecastApi.requirement(projectId as string, key as string)));

export const useDraftReleaseForecast = (projectId: string | undefined, enabled: boolean) =>
  useQuery({ ...forecastRead("release-draft", [projectId], () => forecastApi.draftRelease(projectId as string)), enabled: Boolean(projectId) && enabled });

export const useRequirementForecasts = (projectId: string | undefined) =>
  useQuery(forecastRead("requirements", [projectId], () => forecastApi.requirements(projectId as string)));

/** A triage moves an item's line though no issue moved, so the feedback acts invalidate it by this key. */
export const feedbackForecastKey = (projectId: string) => [...KEY, "feedback", projectId] as const;

export const useFeedbackForecasts = (projectId: string | undefined) => useQuery(forecastRead("feedback", [projectId], () => forecastApi.feedback(projectId as string)));

export const useComingNext = (projectId: string | undefined) => useQuery(forecastRead("coming-next", [projectId], () => forecastApi.comingNext(projectId as string)));

const ETA_SORTS = ["default", "eta"] as const;

/** Whether a list is sorted by its ETA column, kept in the URL as `sort=eta`, and the header's toggle. */
export function useEtaSort(): [boolean, () => void] {
  const [sort, setSort] = useUrlChoice("sort", ETA_SORTS, "default");
  return [sort === "eta", () => setSort(sort === "eta" ? "default" : "eta")];
}

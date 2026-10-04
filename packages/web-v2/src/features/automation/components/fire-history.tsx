"use client";

import { ErrorState, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useScheduleDetail } from "../hooks";
import { FireLines } from "./fire-views";

/** A schedule's recent fires, read from the automation read model, as the schedule page lists them. */
export function FireHistory({ projectId, scheduleId, slug }: { projectId: string; scheduleId: string; slug: string | undefined }) {
  const q = useScheduleDetail(projectId, scheduleId, true);
  if (q.isLoading) return <Spinner size={14} />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} />;
  return slug ? <FireLines fires={q.data.fires} slug={slug} /> : null;
}

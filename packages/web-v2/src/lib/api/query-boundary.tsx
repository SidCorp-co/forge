"use client";

import type { ReactNode } from "react";
import { ErrorState, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "./error";

const HEIGHTS = { "30vh": "min-h-[30vh]", "40vh": "min-h-[40vh]", "50vh": "min-h-[50vh]", "60vh": "min-h-[60vh]" } as const;

interface BoundaryQuery<T> {
  isLoading: boolean;
  isError: boolean;
  data: T | undefined;
  error: unknown;
  refetch: () => unknown;
}

/** The loading and failed shells of a query-backed view, with no wrapper of their own once the data is in: `children` receives the data. `title` (a page title, top-bar actions) is drawn in the loading and failed shells too, so the header never vanishes while the body waits. `retry` is `"retryable"` unless the failure is one a second attempt cannot fix, or `"always"`. */
export function QueryBoundary<T>({
  query,
  loadingLabel,
  title,
  height = "40vh",
  retry = "retryable",
  children,
}: {
  query: BoundaryQuery<T>;
  loadingLabel: string;
  title?: ReactNode;
  height?: keyof typeof HEIGHTS;
  retry?: "always" | "retryable";
  children: (data: T) => ReactNode;
}) {
  const shell = `grid ${HEIGHTS[height]} place-items-center`;
  if (query.isLoading) {
    return (
      <div className={shell}>
        {title}
        <ProjectLoader label={loadingLabel} />
      </div>
    );
  }
  if (query.isError || query.data === undefined || query.data === null) {
    const retryable = retry === "always" || isRetryableApiError(query.error);
    return (
      <div className={shell}>
        {title}
        <ErrorState message={formatApiError(query.error)} onRetry={retryable ? () => query.refetch() : undefined} />
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

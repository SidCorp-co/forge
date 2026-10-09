"use client";

import { useQuery } from "@tanstack/react-query";
import { intakeApi } from "./api";

/** The draft the intake assistant made when the item was created. */
export function useIntakeDraft(projectId: string | undefined, ref: string | undefined) {
  return useQuery({
    queryKey: ["intake-draft", projectId ?? "", ref ?? ""],
    queryFn: () => intakeApi.draft(projectId as string, ref as string),
    enabled: Boolean(projectId && ref),
    staleTime: 10_000,
  });
}

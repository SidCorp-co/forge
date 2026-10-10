"use client";

import { useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { needsYouApi } from "./api";

/** Every key of this read starts here, so a write anywhere can refresh the counts in one call. */
export const NEEDS_YOU_ROOT = ["needs-you"] as const;
export const needsYouKey = (projectId: string) => [...NEEDS_YOU_ROOT, projectId] as const;

export const useNeedsYou = (projectId: string | undefined) => useQuery(readOf(needsYouKey(projectId ?? ""), () => needsYouApi.read(projectId as string)));

export const needsYouDecisionsKey = (projectId: string) => [...NEEDS_YOU_ROOT, projectId, "decisions"] as const;

/** The decisions only the viewer can make (REQ-41 BC-1), the read the home and the chat share. */
export const useNeedsYouDecisions = (projectId: string | undefined) =>
  useQuery(readOf(needsYouDecisionsKey(projectId ?? ""), () => needsYouApi.decisions(projectId as string)));

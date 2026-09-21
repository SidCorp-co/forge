"use client";


import { useQuery } from "@tanstack/react-query";
import { activityApi, type ListActivityOpts } from "./api";

/** Cross-project activity feed. Keyed `['chat-logs','list',opts]`. */
export function useActivity(opts: ListActivityOpts) {
  return useQuery({
    queryKey: ["chat-logs", "list", opts],
    queryFn: () => activityApi.list(opts),
    refetchOnWindowFocus: true,
  });
}

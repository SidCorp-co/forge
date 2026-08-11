"use client";

import { useQuery } from "@tanstack/react-query";
import { operatorApi } from "./api";

export function useOperatorWhoami() {
  return useQuery({
    queryKey: ["operator", "whoami"],
    queryFn: operatorApi.whoami,
    staleTime: 60_000,
    retry: false,
  });
}

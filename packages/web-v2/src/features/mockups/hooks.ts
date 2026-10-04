"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mockupsApi } from "./api";
import type { MockupTarget, ProposeMockupRequest } from "./types";

const listKey = (projectId: string, t: MockupTarget) => ["mockups", projectId, t.type, t.key];

export function useMockups(projectId: string, target: MockupTarget) {
  return useQuery({
    queryKey: listKey(projectId, target),
    queryFn: () => mockupsApi.list(projectId, target),
    staleTime: 15_000,
  });
}

export function useMockupBytes(url: string, enabled = true) {
  return useQuery({ queryKey: ["mockup-bytes", url], queryFn: () => mockupsApi.bytes(url), enabled, staleTime: 10 * 60_000 });
}

function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["mockups", projectId] });
    qc.invalidateQueries({ queryKey: ["requirement", projectId] });
  };
}

export function useProposeMockup(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({ mutationFn: (body: ProposeMockupRequest) => mockupsApi.propose(projectId, body), onSettled: invalidate });
}

export function useMockupAct(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (a: { key: string; act: "accept" | "return" | "withdraw"; reason?: string }) => mockupsApi.act(projectId, a.key, a.act, a.reason),
    onSettled: invalidate,
  });
}

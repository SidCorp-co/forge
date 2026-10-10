"use client";

import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { mockupsApi } from "./api";
import type { MockupTarget, ProposeMockupRequest } from "./types";

const listKey = (projectId: string, t: MockupTarget) => ["mockups", projectId, t.type, t.key];

export const useMockups = (projectId: string, target: MockupTarget) => useQuery(readOf(listKey(projectId, target), () => mockupsApi.list(projectId, target)));

export function useMockupBytes(url: string, enabled = true) {
  return useQuery({ queryKey: ["mockup-bytes", url], queryFn: () => mockupsApi.bytes(url), enabled, staleTime: 10 * 60_000 });
}

/** A text mockup's body (a wireframe's JSON, an HTML page), read from the same bytes. */
export function useMockupText(url: string, enabled = true) {
  return useQuery({ queryKey: ["mockup-text", url], queryFn: async () => (await mockupsApi.bytes(url)).text(), enabled, staleTime: 10 * 60_000 });
}

/** The mockups and the requirements they hang on, which every mockup write changes. */
const touched = (projectId: string) => [["mockups", projectId], ["requirement", projectId]];

export const useProposeMockup = (projectId: string) => useWrite((body: ProposeMockupRequest) => mockupsApi.propose(projectId, body), { touches: touched(projectId) });

export const useMockupAct = (projectId: string) =>
  useWrite((a: { key: string; act: "accept" | "return" | "withdraw"; reason?: string }) => mockupsApi.act(projectId, a.key, a.act, a.reason), { touches: touched(projectId) });

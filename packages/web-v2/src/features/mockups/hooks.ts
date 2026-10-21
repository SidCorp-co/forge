
import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { mockupsApi } from "./api";
import { useCallback } from "react";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";
import type { CommentMockupRequest, MockupTarget, ProposeMockupRequest } from "./types";

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
// the Needs you decisions (`features/needs-you` NEEDS_YOU_ROOT) list each mockup waiting on a person
const touched = (projectId: string) => [["mockups", projectId], ["mockup-comments", projectId], ["requirement", projectId], ["needs-you", projectId]];

const commentsKey = (projectId: string, key: string) => ["mockup-comments", projectId, key];

export const useMockupComments = (projectId: string, key: string, enabled = true) =>
  useQuery({ ...readOf(commentsKey(projectId, key), () => mockupsApi.comments(projectId, key)), enabled });

export const useCommentMockup = (projectId: string, key: string) =>
  useWrite((body: CommentMockupRequest) => mockupsApi.comment(projectId, key, body), { touches: touched(projectId) });

/**
 * The mockup this page is about (`?mockup=MK-n`), and whether it is open full screen (`&full=1`). While
 * a mockup is named the Ask Agent chat is about it (REQ-49 BC-4): opening it full screen names it,
 * closing it clears both, and asking the agent from it closes the view and keeps it named.
 */
export function useOpenMockup() {
  const search = useLocationSearch();
  const params = new URLSearchParams(search);
  const named = params.get("mockup");
  const subject = named && /^MK-\d{1,9}$/.test(named) ? named : null;
  const write = useCallback(
    (mockup: string | null, full: boolean) => {
      const sp = new URLSearchParams(window.location.search);
      if (mockup) sp.set("mockup", mockup);
      else sp.delete("mockup");
      if (full) sp.set("full", "1");
      else sp.delete("full");
      const qs = sp.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
      notifyLocationChange();
    },
    [],
  );
  return {
    subject,
    full: subject !== null && params.get("full") === "1",
    open: useCallback((key: string) => write(key, true), [write]),
    close: useCallback((keep = false) => write(keep ? subject : null, false), [write, subject]),
  };
}

export const useProposeMockup = (projectId: string) => useWrite((body: ProposeMockupRequest) => mockupsApi.propose(projectId, body), { touches: touched(projectId) });

export const useMockupAct = (projectId: string) =>
  useWrite((a: { key: string; act: "accept" | "return" | "withdraw"; reason?: string }) => mockupsApi.act(projectId, a.key, a.act, a.reason), { touches: touched(projectId) });

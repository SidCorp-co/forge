// The session feature's reads: one key factory and its queryOptions. The `agent-session` prefix is
// the one the WebSocket router invalidates (`lib/ws/event-router.ts`), so the shapes stay as they are.
import { queryOptions } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { sessionApi } from "./api";
import { fetchAllTurns, TURN_PAGE_CAP } from "./turns";

export const sessionKeys = {
  all: ["agent-session"] as const,
  detail: (id: string | undefined) => [...sessionKeys.all, id] as const,
  turns: (id: string | undefined, pages: number) => [...sessionKeys.detail(id), "turns", pages] as const,
};

export const sessionQueries = {
  detail: (id: string | undefined) =>
    readOf(sessionKeys.detail(id), () => sessionApi.detail(id as string), 0),
  turns: (id: string | undefined, pages: number = TURN_PAGE_CAP) =>
    queryOptions({
      ...readOf(sessionKeys.turns(id, pages), () => fetchAllTurns(id as string, pages), 0),
      // Keeps the loaded turns on screen while more pages load, never across sessions.
      placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
    }),
};

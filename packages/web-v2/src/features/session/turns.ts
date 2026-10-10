// Loading a session's turns page by page, up to a cap of pages.
import { sessionApi } from "./api";
import type { TurnRow, TurnsResponse } from "./types";

export const TURN_PAGE_SIZE = 500;
export const TURN_PAGE_CAP = 40;

export async function fetchAllTurns(id: string, pages: number = TURN_PAGE_CAP): Promise<TurnsResponse> {
  const turns: TurnRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const res = await sessionApi.getTurns(id, { after, limit: TURN_PAGE_SIZE });
    turns.push(...res.turns);
    if (!res.nextCursor) return { turns, nextCursor: null };
    after = res.nextCursor;
  }
  return { turns, nextCursor: after ?? null };
}

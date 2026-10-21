import type { ItemStanding, StandingSubjectKind, StewardNoteSubjectKind } from "@forge/contracts/steward";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { readOf } from "@/lib/api/query-kit";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { standingApi } from "./api";

// under ['issues','standing'] so the event router, which invalidates that prefix on every issue event,
// rereads the standings and the notes beside the issue standings they roll up from
const KEY = ["issues", "standing", "steward"] as const;

/** The one standing read, by `kind:key`, so a list row finds its own standing and note. */
export function useStandings(projectId: string | undefined): ReadonlyMap<string, ItemStanding> {
  const q = useQuery(readOf([...KEY, "standings", projectId], () => standingApi.standings(projectId as string), 10_000));
  return useMemo(() => new Map((q.data?.standings ?? []).map((s) => [standingKeyOf(s.subject.kind, s.subject.key), s])), [q.data]);
}

/** Each current note's line 1 by item key, for one kind's list rows; a stale note leaves its row bare. */
export function useNoteLines(projectId: string | undefined, kind: StandingSubjectKind): ReadonlyMap<string, string> {
  const standings = useStandings(projectId);
  return useMemo(() => {
    const lines = new Map<string, string>();
    for (const s of standings.values()) {
      const line = s.note && !s.note.stale ? s.note.lines[0] : undefined;
      if (s.subject.kind === kind && line) lines.set(s.subject.key, line);
    }
    return lines;
  }, [standings, kind]);
}

/** Core's stuck sentence by item key for one kind, in the viewer's language; an item not stuck is absent. */
export function useStuckReasons(projectId: string | undefined, kind: StandingSubjectKind): ReadonlyMap<string, string> {
  const standings = useStandings(projectId);
  const language = useInterfaceLanguage();
  return useMemo(() => {
    const reasons = new Map<string, string>();
    for (const s of standings.values()) if (s.subject.kind === kind && s.stuck) reasons.set(s.subject.key, said(s.stuck.says.reason, language));
    return reasons;
  }, [standings, kind, language]);
}

export const standingKeyOf = (kind: StandingSubjectKind, key: string) => `${kind}:${key}`;

/** One item's current steward note (BC-7), null where none is written. */
export const useStewardNote = (projectId: string | undefined, kind: StewardNoteSubjectKind, key: string | undefined) =>
  useQuery(readOf([...KEY, "note", projectId, kind, key], () => standingApi.note(projectId as string, kind, key as string), 10_000)).data?.note ?? null;

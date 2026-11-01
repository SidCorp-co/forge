// What runs on a project now, as the project bar draws it (REQ-15 BC-10): read from the run standing
// with its master beside it and from each support room's turn, and derived into nothing core did not
// say. A source that did not answer is named unreadable, never read as idle (VISION: state-never-lies).
import type { SupportRoomTurn, SupportTurnsView } from "@forge/contracts/project-now";
import type { MasterStanding, RunStanding, RunStandingList } from "./types";

/** How the bar names the master: present or absent, working or idle. */
export type MasterWord = "working" | "idle" | "waiting" | "silent" | "absent";

const MASTER_WORD: Record<MasterStanding["state"], MasterWord> = {
  in_pass: "working",
  // no pass is open: its runs are listed on their own
  runs_out: "idle",
  idle: "idle",
  waiting_person: "waiting",
  silent: "silent",
  none: "absent",
};

export type NowItem =
  | { kind: "master"; word: MasterWord; issueKey: string | null }
  | { kind: "run"; run: RunStanding }
  | { kind: "release"; run: RunStanding }
  | { kind: "deploy"; run: RunStanding }
  | { kind: "room"; room: SupportRoomTurn };

/** A read as the bar holds it: still loading, failed, or its answer. */
export type Read<T> = { state: "loading" } | { state: "unreadable" } | { state: "read"; data: T };

export type NowSource = "runs" | "rooms";

export interface ProjectNow {
  items: NowItem[];
  /** Sources that did not answer; the bar says so for each, and never says nothing runs while one stands. */
  unreadable: NowSource[];
  loading: boolean;
  /** Something moves: a run, a working or waiting master, a room answering or waited on. */
  busy: boolean;
  /** The newest instant anything finished or moved, for the line that says nothing runs. */
  lastActivityAt: string | null;
}

const laneKind = (r: RunStanding): "run" | "release" | "deploy" =>
  r.lane === "release" ? "release" : r.lane === "deploy" ? "deploy" : "run";

const newest = (instants: (string | null | undefined)[]): string | null =>
  instants.reduce<string | null>((best, at) => (at && (!best || Date.parse(at) > Date.parse(best)) ? at : best), null);

export function projectNowOf(live: Read<RunStandingList>, recent: Read<RunStandingList>, rooms: Read<SupportTurnsView>): ProjectNow {
  const items: NowItem[] = [];
  const unreadable: NowSource[] = [];
  if (live.state === "read") {
    const m = live.data.master;
    items.push({ kind: "master", word: MASTER_WORD[m.state], issueKey: m.pass?.issueKey ?? null });
    for (const run of live.data.items) items.push({ kind: laneKind(run), run });
  } else if (live.state === "unreadable") unreadable.push("runs");
  if (rooms.state === "read") {
    for (const room of rooms.data.rooms) if (room.state !== "quiet") items.push({ kind: "room", room });
  } else if (rooms.state === "unreadable") unreadable.push("rooms");
  const busy = items.some((i) => i.kind !== "master" || i.word === "working" || i.word === "waiting");
  const finished = recent.state === "read" ? recent.data.items.map((r) => r.finishedAt) : [];
  const lastPass = live.state === "read" ? [live.data.master.lastPass?.endedAt] : [];
  const roomActs = rooms.state === "read" ? rooms.data.rooms.map((r) => r.lastActivityAt) : [];
  return {
    items,
    unreadable,
    loading: live.state === "loading" || rooms.state === "loading",
    busy,
    lastActivityAt: newest([...finished, ...lastPass, ...roomActs]),
  };
}

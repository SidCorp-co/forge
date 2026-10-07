export type ChatTarget =
  | { kind: "draft"; projectId: string; ecosystemId?: string | null; draft?: string }
  | { kind: "room"; projectId: string; conversationId: string }
  /** Nothing picked yet: the project's latest live conversation, resolved once its list is read (ISS-277). */
  | { kind: "latest"; projectId: string }
  | { kind: "people" };

export const DOCK_MIN_WIDTH = 360;
export const DOCK_MAX_WIDTH = 900;
export const DOCK_DEFAULT_WIDTH = 400;

/** The panel's width before a person drags it: 400px, 380 under a 1300px window (the chat panel prototype, ISS-63). */
export const defaultDockWidth = () =>
  typeof window !== "undefined" && window.innerWidth < 1300 ? 380 : DOCK_DEFAULT_WIDTH;

export const clampDockWidth = (w: number) =>
  Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Number.isFinite(w) ? w : DOCK_DEFAULT_WIDTH)));

// the dock's scope is the project the rail has selected: with nothing picked, or a pick left over
// from another project, it opens on this project's latest conversation rather than a fresh draft,
// so a reload, a new tab or a project switch does not strand the conversation the person was having
// (ISS-277); a room with other people carries no project to drift from
export function targetInScope(target: ChatTarget | null, projectId: string | null): ChatTarget | null {
  if (!projectId) return target?.kind === "people" ? target : null;
  if (!target) return { kind: "latest", projectId };
  if (target.kind === "people" || target.projectId === projectId) return target;
  return { kind: "latest", projectId };
}

/** A room as the conversation list reads it, as much as the dock needs to choose one. */
export interface DockRoom {
  id: string;
  projectId: string;
  updatedAt: string;
  archivedAt: string | null;
  subjectKey?: string | null;
  threadStatus?: string | null;
}

const waitsOnYou = (r: DockRoom) => r.threadStatus === "waiting_on_you";

// a room waiting on the person first, then the newest
function first<R extends DockRoom>(rows: R[]): R | undefined {
  return [...rows].sort(
    (a, b) => Number(waitsOnYou(b)) - Number(waitsOnYou(a)) || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
}

const liveIn = <R extends DockRoom>(rows: R[], projectId: string) =>
  rows.filter((r) => r.projectId === projectId && r.archivedAt === null);

/** What the dock opens on when nothing is picked: the page's own rooms first, then the project's; a draft only when it has none. */
export function openingTarget(rows: DockRoom[], at: { projectId: string; pageKey: string | null }): ChatTarget {
  const live = liveIn(rows, at.projectId);
  const pick = first(live.filter((r) => at.pageKey !== null && r.subjectKey === at.pageKey)) ?? first(live);
  return pick ? { kind: "room", projectId: at.projectId, conversationId: pick.id } : { kind: "draft", projectId: at.projectId };
}

/** The newest room in the project waiting on the person, other than the one open. */
export function waitingRoom<R extends DockRoom>(rows: R[], at: { projectId: string; openId: string | null }): R | null {
  return first(liveIn(rows, at.projectId).filter((r) => waitsOnYou(r) && r.id !== at.openId)) ?? null;
}

export const targetConversationId = (t: ChatTarget | null) => (t?.kind === "room" ? t.conversationId : null);

export type ChatTarget =
  | { kind: "draft"; projectId: string; ecosystemId?: string | null; draft?: string }
  | { kind: "room"; projectId: string; conversationId: string }
  /** Nothing picked yet: the project's latest live conversation, resolved once its list is read (ISS-277). */
  | { kind: "latest"; projectId: string }
  | { kind: "people" };

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
  /** The thread's kind: a requirement, first-requirements or onboarding room is scoped to it. */
  kind?: string | null;
}

const waitsOnYou = (r: DockRoom) => r.threadStatus === "waiting_on_you";

/** A room whose agent reads one record or one onboarding rather than the project. */
export const isScopedRoom = (r: Pick<DockRoom, "kind" | "subjectKey">) => Boolean(r.kind || r.subjectKey);

// a room waiting on the person first, then the newest
function first<R extends DockRoom>(rows: R[]): R | undefined {
  return [...rows].sort(
    (a, b) => Number(waitsOnYou(b)) - Number(waitsOnYou(a)) || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
}

const liveIn = <R extends DockRoom>(rows: R[], projectId: string) =>
  rows.filter((r) => r.projectId === projectId && r.archivedAt === null);

/**
 * What the dock opens on when nothing is picked: the page's own rooms first, then the project's; a
 * draft only when it has none. A room scoped to a record is reused off that record's page only when
 * it waits on the person: a whole-project question asked there is refused by a room that reads one
 * requirement, and nothing told the person why (FB-100).
 */
export function openingTarget(rows: DockRoom[], at: { projectId: string; pageKey: string | null }): ChatTarget {
  const live = liveIn(rows, at.projectId);
  const own = live.filter((r) => at.pageKey !== null && r.subjectKey === at.pageKey);
  const pick = first(own) ?? first(live.filter((r) => !isScopedRoom(r) || waitsOnYou(r)));
  return pick ? { kind: "room", projectId: at.projectId, conversationId: pick.id } : { kind: "draft", projectId: at.projectId };
}

/** The newest room in the project waiting on the person, other than the one open. */
export function waitingRoom<R extends DockRoom>(rows: R[], at: { projectId: string; openId: string | null }): R | null {
  return first(liveIn(rows, at.projectId).filter((r) => waitsOnYou(r) && r.id !== at.openId)) ?? null;
}

export const targetConversationId = (t: ChatTarget | null) => (t?.kind === "room" ? t.conversationId : null);

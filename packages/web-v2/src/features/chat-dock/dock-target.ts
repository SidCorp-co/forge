export type ChatTarget =
  | { kind: "draft"; projectId: string; ecosystemId?: string | null; draft?: string }
  | { kind: "room"; projectId: string; conversationId: string }
  | { kind: "people" };

export const DOCK_MIN_WIDTH = 360;
export const DOCK_MAX_WIDTH = 900;
export const DOCK_DEFAULT_WIDTH = 400;

/** The panel's width before a person drags it: 400px, 380 under a 1300px window (the chat panel prototype, ISS-63). */
export const defaultDockWidth = () =>
  typeof window !== "undefined" && window.innerWidth < 1300 ? 380 : DOCK_DEFAULT_WIDTH;

export const clampDockWidth = (w: number) =>
  Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Number.isFinite(w) ? w : DOCK_DEFAULT_WIDTH)));

// the dock's scope is the project the rail has selected: a target left over from another project is dropped for a fresh draft in this one, and a room with other people carries no project to drift from
export function targetInScope(target: ChatTarget | null, projectId: string | null): ChatTarget | null {
  if (!projectId) return target?.kind === "people" ? target : null;
  if (!target) return { kind: "draft", projectId };
  if (target.kind === "people" || target.projectId === projectId) return target;
  return { kind: "draft", projectId };
}

export const targetConversationId = (t: ChatTarget | null) => (t?.kind === "room" ? t.conversationId : null);

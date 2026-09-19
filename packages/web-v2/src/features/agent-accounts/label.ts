import type { AgentAccountRow } from "./types";


/**
 * The name to print.
 */
export function agentLabel(agent: Pick<AgentAccountRow, "displayName" | "handle" | "email">): string {
  const label = agent.displayName?.trim();
  if (label) return label;
  if (agent.handle) return agent.handle;
  return agent.email;
}

/** Every project this agent works on, as a person reads them. */
export function agentProjectNames(
  agent: Pick<AgentAccountRow, "projects">,
  nameOf: (projectId: string) => string | undefined,
): string {
  if (agent.projects.length === 0) return "none";
  return agent.projects.map((p) => nameOf(p.id) ?? p.id).join(", ");
}

/** The address, as it is typed. */
export function agentAddress(agent: Pick<AgentAccountRow, "handle">): string {
  return agent.handle ? `@${agent.handle}` : "—";
}

export type Reach = { canAct: true } | { canAct: false; why: string; remedy: string };

/**
 * Whether this agent can act, and what to do about it when it cannot.
 */
export function reachOf(
  agent: Pick<AgentAccountRow, "canAct" | "projects" | "activeTokens">,
): Reach {
  if (agent.canAct) return { canAct: true };
  if (agent.projects.length === 0) {
    return {
      canAct: false,
      why: "belongs to no project",
      remedy: agent.activeTokens > 0
        ? "Add it to a project — its credential is fenced to one and reaches nothing until then."
        : "Add it to a project, then give it a credential.",
    };
  }
  return {
    canAct: false,
    why: "holds no live credential",
    remedy: "Give it a credential — it cannot answer in a room without one.",
  };
}

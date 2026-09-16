import type { AgentAccountRow } from "./types";

/**
 * What a person reads for one agent, and what it means that it can or cannot act.
 *
 * Pure, and tested on its own, because both answers are rules rather than
 * rendering: which of three strings stands for this account's name, and what an
 * admin is supposed to do about a row that cannot act.
 */

/**
 * The name to print.
 */
export function agentLabel(agent: Pick<AgentAccountRow, "displayName" | "handle" | "email">): string {
  const label = agent.displayName?.trim();
  if (label) return label;
  if (agent.handle) return agent.handle;
  return agent.email;
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
  agent: Pick<AgentAccountRow, "canAct" | "projectId" | "activeTokens">,
): Reach {
  if (agent.canAct) return { canAct: true };
  if (!agent.projectId) {
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

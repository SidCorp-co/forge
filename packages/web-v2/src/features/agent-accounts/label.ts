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
// cm:guard the fallback chain is displayName → handle → address, and the ADDRESS is last for the reason the two columns exist: it is a synthesized string at a reserved-invalid domain with a random suffix, and printing it is what ISS-1003 set out to stop. It is kept as the final fallback rather than dropped because a row that somehow carries neither of the other two must still render as something a person can point at.
export function agentLabel(agent: Pick<AgentAccountRow, "displayName" | "handle" | "email">): string {
  const label = agent.displayName?.trim();
  if (label) return label;
  if (agent.handle) return agent.handle;
  return agent.email;
}

/** Every project this agent works on, as a person reads them. */
// cm:guard an agent with no project renders as a named ABSENCE and not as an empty cell: "belongs to no project" is the state `reachOf` sends an admin to fix, and a blank there reads as a column that failed to load.
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
// cm:guard an agent that cannot act is given a REMEDY and not just a badge. The population this screen exists for is the handles a conversation minted — a name in a room with no token, permanently unable to answer — and "no credential" with no next step is the state that went unnoticed long enough to become this issue.
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

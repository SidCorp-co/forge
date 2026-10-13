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

/** An id is never a name: one that does not resolve is removed or not shared, which the list cannot tell apart. */
export function agentProjectNames(
  agent: Pick<AgentAccountRow, "projects">,
  nameOf: (projectId: string) => string | undefined,
  loading = false,
): string {
  if (agent.projects.length === 0) return "none";
  if (loading) return "Loading projects…";
  const names: string[] = [];
  let unresolved = 0;
  for (const { id } of agent.projects) {
    const name = nameOf(id);
    if (name === undefined) unresolved += 1;
    else names.push(name);
  }
  if (unresolved > 0) {
    names.push(`${unresolved} project${unresolved === 1 ? "" : "s"} removed or not shared with you`);
  }
  return names.join(", ");
}

/** The address, as it is typed. */
export function agentAddress(agent: Pick<AgentAccountRow, "handle">): string {
  return agent.handle ? `@${agent.handle}` : "—";
}

export type Reach = { canAct: true } | { canAct: false; why: string };

/** Whether this agent can act, and why not. The advice is the same for all and stands above the table. */
export function reachOf(agent: Pick<AgentAccountRow, "canAct" | "projects">): Reach {
  if (agent.canAct) return { canAct: true };
  return {
    canAct: false,
    why: agent.projects.length === 0 ? "belongs to no project" : "holds no live credential",
  };
}

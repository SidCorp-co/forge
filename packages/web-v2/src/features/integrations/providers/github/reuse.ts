import { personName } from "@forge/contracts/person-name";
import type { ConnectionDirectoryItem } from "@forge/contracts";

/** The project a GitHub App is being offered to — what the bind rule is asked about. */
export interface ReuseTarget {
  orgId: string;
  orgName: string;
}

/** Whether the bind-existing door would accept it: the server's `canManage`, and an org-owned one only inside its own org. */
export function canBindHere(connection: ConnectionDirectoryItem, project: ReuseTarget | null): boolean {
  if (!connection.access.canManage) return false;
  if (connection.ownerType === "org") return project !== null && connection.ownerId === project.orgId;
  return true;
}

/** The active GitHub Apps this project can bind, in directory order. */
export function bindableApps(
  connections: ConnectionDirectoryItem[],
  project: ReuseTarget | null,
): ConnectionDirectoryItem[] {
  return connections.filter(
    (c) => c.provider === "github" && c.active && canBindHere(c, project),
  );
}

/**
 * Why a reachable App is not offered, naming its owner and who can bind it; null where there is nothing
 * to say. A separate App is offered only to a reader who may create one (ISS-1421 r24).
 */
export function unbindableReason(
  connections: ConnectionDirectoryItem[],
  project: ReuseTarget | null,
  mayCreate = true,
): string | null {
  const reachable = connections.filter((c) => c.provider === "github" && c.active);
  if (reachable.length === 0 || reachable.some((c) => canBindHere(c, project))) return null;
  const first = reachable[0] as ConnectionDirectoryItem;
  const name = first.displayName ?? "A GitHub App";
  const owner = first.access.ownerName;
  if (first.ownerType === "org") {
    if (project && first.ownerId !== project.orgId) {
      const who = owner ? `the organization ${owner}` : "another organization";
      return `${name} is owned by ${who}, and only a project in it can use it — this project is not. An owner or admin of ${owner ?? "that organization"} can use it from there.${mayCreate ? " Create a separate App below to use one here." : ""}`;
    }
    const org = project && first.ownerId === project.orgId ? project.orgName : (owner ?? "its organization");
    return `${name} is owned by ${org}, and only an owner or admin of ${org} can share it with this project — ask them${mayCreate ? ", or create a separate App below" : ""}.`;
  }
  const person = personName(owner);
  return `${name} is owned by ${person}, and only ${owner ? "they" : "its owner"} can share it with this project — ask ${owner ? person : "its owner"}${mayCreate ? ", or create a separate App below" : ""}.`;
}

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

/** Why a reachable App is not offered, naming its owner and who can bind it; null where there is nothing to say. */
export function unbindableReason(
  connections: ConnectionDirectoryItem[],
  project: ReuseTarget | null,
): string | null {
  const reachable = connections.filter((c) => c.provider === "github" && c.active);
  if (reachable.length === 0 || reachable.some((c) => canBindHere(c, project))) return null;
  const first = reachable[0] as ConnectionDirectoryItem;
  const name = first.displayName ?? "A GitHub App";
  if (first.ownerType === "org" && project && first.ownerId !== project.orgId) {
    return `${name} already serves this workspace, but it belongs to a different organization than this project, so it can only be used there. Create a separate App below.`;
  }
  const owner =
    first.ownerType === "org"
      ? `${project && first.ownerId === project.orgId ? project.orgName : "another organization"}, and only an owner or admin of it`
      : "another user, and only its owner";
  return `${name} already serves this workspace. It is owned by ${owner} can bind it to this project — ask them, or create a separate App below.`;
}

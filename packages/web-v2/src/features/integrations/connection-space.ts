import type { ConnectionDirectoryItem } from "@forge/contracts";

export interface DirectorySpace {
  id: string;
  isPersonal: boolean;
}

/** A space holds what its owner has and what its projects bind without owning (ISS-1216). */
export function connectionInSpace(
  connection: ConnectionDirectoryItem,
  space: DirectorySpace | null,
  projectOrgId: (projectId: string) => string | undefined,
): boolean {
  if (!space) return true;
  if (space.isPersonal) {
    if (connection.ownerType === "user" && connection.access.reach === "owner") return true;
  } else if (connection.ownerType === "org" && connection.ownerId === space.id) {
    return true;
  }
  return (
    connection.access.reach === "binding" &&
    connection.usage.bindings.some((b) => projectOrgId(b.projectId) === space.id)
  );
}

export function connectionOwnerLabel(
  connection: ConnectionDirectoryItem,
  orgName: (orgId: string) => string | undefined,
): string {
  if (connection.ownerType === "org") return orgName(connection.ownerId) ?? "Organization";
  return connection.access.reach === "owner" ? "Personal" : "Another user";
}

/** Why a row offers no controls, and who may change the credential. */
export function readOnlyNote(connection: ConnectionDirectoryItem, ownerLabel: string): string {
  return connection.ownerType === "org"
    ? `Read-only — only an owner or admin of ${ownerLabel} can change this credential.`
    : "Read-only — only its owner can change this credential.";
}

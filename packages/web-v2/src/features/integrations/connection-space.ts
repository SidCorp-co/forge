import type { ConnectionDirectoryItem } from "@forge/contracts";
import { personName, UNNAMED_PERSON } from "@forge/contracts/person-name";

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

/** Who owns a credential, as a row labels them: an organization, "Personal" for the caller's own, else the person by `personName` (ISS-1229 r22). */
export function connectionOwnerLabel(
  connection: ConnectionDirectoryItem,
  orgName: (orgId: string) => string | undefined,
): string {
  if (connection.ownerType === "org")
    return orgName(connection.ownerId) ?? connection.access.ownerName ?? "Organization";
  if (connection.access.reach === "owner") return "Personal";
  return personName(connection.access.ownerName, "start");
}

/**
 * Who may change a credential, as a sentence's subject: the people `managesConnection` admits, never
 * an organization's admins over a person's (ISS-1421 r28, r29).
 */
export function whoChangesConnection(connection: ConnectionDirectoryItem, ownerLabel: string): string {
  if (connection.ownerType === "org") return `an owner or admin of ${ownerLabel}`;
  const named = connection.access.ownerName;
  return named && named !== UNNAMED_PERSON ? `its owner, ${named},` : "the member who owns it";
}

/** Why a row or a drawer offers no controls, and who may change the credential. */
export function readOnlyNote(connection: ConnectionDirectoryItem, ownerLabel: string): string {
  return `Read-only — only ${whoChangesConnection(connection, ownerLabel)} can change this credential.`;
}

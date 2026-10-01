import type { ProjectListItem } from "./types";

/**
 * Whether this project role may write on the project: a member or an admin. A viewer reads, and so
 * does a `null` role — org access without project membership — and so does a role not loaded yet.
 * Core's write routes (`START_ROLE` among them) require the same.
 */
export function canWriteProject(role: ProjectListItem["role"] | undefined): boolean {
  return role === "member" || role === "admin";
}

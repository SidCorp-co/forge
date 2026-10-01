import type { ProjectListItem } from "./types";

const WRITE_ROLES: ReadonlySet<ProjectListItem["role"] | undefined> = new Set(["member", "admin"]);

export function canWriteProject(role: ProjectListItem["role"] | undefined): boolean {
  return WRITE_ROLES.has(role);
}

import type { OrgRole } from "@/features/orgs/types";
import type { ProjectListItem } from "./types";

type ProjectRole = ProjectListItem["role"] | undefined;

const WRITE_ROLES: ReadonlySet<ProjectRole> = new Set(["member", "admin"]);

export function canWriteProject(role: ProjectRole): boolean {
  return WRITE_ROLES.has(role);
}

export function canManageProject(role: ProjectRole): boolean {
  return role === "admin";
}

export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

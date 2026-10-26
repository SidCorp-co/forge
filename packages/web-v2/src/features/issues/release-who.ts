import type { ProjectListItem } from "@/features/projects/types";

export const WHO_RELEASES = "an admin of this project";

export function askWhoReleases(what: string): string {
  return `Only ${WHO_RELEASES} can release ${what}, so ask one of them.`;
}

/** Org owners and admins read as a project admin here, as they hold it implicitly. */
export function mayRelease(role: ProjectListItem["role"] | undefined): boolean {
  return role === "admin";
}

import type { OrgListItem } from "./types";

export function workspaceName(org: Pick<OrgListItem, "name" | "isPersonal">): string {
  const name = org.name.trim();
  if (name) return name;
  return org.isPersonal ? "Personal" : "Unnamed organization";
}

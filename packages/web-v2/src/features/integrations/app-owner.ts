// The twin of core's held-key.ts:takesTheApp, which an install whose App is someone else's is refused by.
export function takesTheApp(
  connection: { ownerType: "user" | "org"; ownerId: string },
  project: { orgId: string | null; orgIsPersonal: boolean },
): boolean {
  return connection.ownerType === "org"
    ? !project.orgIsPersonal && project.orgId === connection.ownerId
    : project.orgIsPersonal;
}

// The twin of core's ORG_ADMIN_REQUIRED: an App belonging to a shared org is created by its owners and admins.
export function mayCreateTheApp(project: {
  orgIsPersonal: boolean;
  orgRole: "owner" | "admin" | "member" | null;
}): boolean {
  return project.orgIsPersonal || project.orgRole === "owner" || project.orgRole === "admin";
}

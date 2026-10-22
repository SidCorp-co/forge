// The twin of core's held-key.ts:takesTheApp, which an install whose App is someone else's is refused by.
export function takesTheApp(
  connection: { ownerType: "user" | "org"; ownerId: string },
  project: { orgId: string | null; orgIsPersonal: boolean },
): boolean {
  return connection.ownerType === "org"
    ? !project.orgIsPersonal && project.orgId === connection.ownerId
    : project.orgIsPersonal;
}

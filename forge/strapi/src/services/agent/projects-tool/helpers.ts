/** Resolve a target project by slug. Returns the project documentId or null. */
export async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents('api::project.project').findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

/** Resolve a user by documentId or username. Returns the user documentId or null. */
export async function resolveUser(strapi: any, identifier: string): Promise<string | null> {
  const user = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { $or: [{ documentId: identifier }, { username: identifier }] },
    select: ['documentId'],
  });
  return user?.documentId || null;
}

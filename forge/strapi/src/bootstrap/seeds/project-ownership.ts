export async function seedProjectOwnership(strapi: any) {
  const projects = await strapi.documents('api::project.project').findMany({
    populate: ['owner'],
  });
  const unowned = projects.filter((p: any) => !p.owner);
  if (unowned.length === 0) return;

  const firstUser = await strapi.db
    .query('plugin::users-permissions.user')
    .findOne({ orderBy: { id: 'asc' } });
  if (!firstUser) return;

  for (const project of unowned) {
    await strapi.documents('api::project.project').update({
      documentId: project.documentId,
      data: { owner: firstUser.documentId },
    });
  }
  strapi.log.info(`Assigned ${unowned.length} unowned projects to user "${firstUser.username}"`);
}

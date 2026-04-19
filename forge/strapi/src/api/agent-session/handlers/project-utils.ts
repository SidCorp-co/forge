/** Look up a project's defaultDevice.deviceId by slug. */
export async function getProjectDeviceId(strapi: any, projectSlug: string): Promise<string | null> {
  const projects = await strapi.documents('api::project.project').findMany({
    filters: { slug: { $eq: projectSlug } },
    populate: ['defaultDevice'],
    limit: 1,
  });
  return projects[0]?.defaultDevice?.deviceId || null;
}
